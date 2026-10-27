-- Apply after supabase-wallet.sql and the direct-treasury wallet setup.
-- This adds a ledger-backed withdrawal record so transfers are tracked, retried safely, and tied to a verified Solana wallet.

create table if not exists public.wallet_withdrawals (
    id uuid primary key default gen_random_uuid(),
    player_id uuid not null references public.player_profiles (id) on delete cascade,
    wallet_address text not null,
    amount_credits bigint not null check (amount_credits > 0),
    amount_raw bigint not null check (amount_raw > 0),
    token_decimals integer not null default 8 check (token_decimals between 0 and 18),
    status text not null default 'pending' check (status in ('pending', 'submitted', 'confirmed', 'failed', 'cancelled')),
    idempotency_key text not null unique,
    transaction_signature text,
    failure_reason text,
    memo text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    confirmed_at timestamptz
);

alter table public.wallet_withdrawals enable row level security;
revoke all on public.wallet_withdrawals from public, anon, authenticated;
grant select on public.wallet_withdrawals to authenticated;
grant select, insert, update on public.wallet_withdrawals to service_role;

drop policy if exists "Players can view their own withdrawals"
    on public.wallet_withdrawals;
create policy "Players can view their own withdrawals"
    on public.wallet_withdrawals for select to authenticated
    using (player_id = (select auth.uid()));

create index if not exists wallet_withdrawals_player_idx
    on public.wallet_withdrawals (player_id, created_at desc);

create or replace function public.process_verified_withdrawal(
    p_player_id uuid,
    p_wallet_address text,
    p_network text,
    p_transaction_signature text,
    p_mint_address text,
    p_token_program_id text,
    p_amount_raw bigint,
    p_token_decimals integer,
    p_amount_credits bigint,
    p_idempotency_key text,
    p_memo text default ''
)
returns table (balance_credits bigint, already_applied boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.wallet_withdrawals%rowtype;
    v_balance bigint;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null
       or p_wallet_address is null
       or p_network is null
       or p_network not in ('devnet', 'mainnet-beta')
       or p_transaction_signature is null
       or p_mint_address is null
       or p_token_program_id is null
       or p_amount_raw is null or p_amount_raw <= 0
       or p_token_decimals is null or p_token_decimals not between 0 and 18
       or p_amount_credits is null or p_amount_credits <= 0
       or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
        raise exception 'Invalid withdrawal payload.' using errcode = '22023';
    end if;

    select * into v_row
    from public.wallet_withdrawals
    where idempotency_key = p_idempotency_key
    for update;

    if found then
        if v_row.player_id <> p_player_id
           or v_row.wallet_address <> p_wallet_address
           or v_row.amount_credits <> p_amount_credits
           or v_row.amount_raw <> p_amount_raw
           or v_row.token_decimals <> p_token_decimals
           or v_row.transaction_signature is distinct from p_transaction_signature then
            raise exception 'Idempotency key was reused for a different withdrawal record.' using errcode = '23505';
        end if;
        select balance_credits into v_balance
        from public.wallet_credit_accounts
        where player_id = p_player_id;
        return query select coalesce(v_balance, 0), true;
        return;
    end if;

    insert into public.wallet_withdrawals (
        player_id, wallet_address, amount_credits, amount_raw, token_decimals,
        status, idempotency_key, transaction_signature, memo, confirmed_at, updated_at
    )
    values (
        p_player_id, p_wallet_address, p_amount_credits, p_amount_raw, p_token_decimals,
        'confirmed', p_idempotency_key, p_transaction_signature, coalesce(p_memo, ''), now(), now()
    );

    select a.balance_credits into v_balance
    from public.wallet_credit_accounts as a
    where a.player_id = p_player_id
    for update;

    if v_balance is null then
        insert into public.wallet_credit_accounts (player_id, balance_credits, updated_at)
        values (p_player_id, 0, now());
        v_balance := 0;
    end if;

    if v_balance < p_amount_credits then
        raise exception 'Insufficient credits for withdrawal.' using errcode = '22023';
    end if;

    update public.wallet_credit_accounts
    set balance_credits = v_balance - p_amount_credits,
        updated_at = now()
    where player_id = p_player_id;

    insert into public.wallet_credit_ledger (
        player_id, entry_type, amount_credits, balance_after_credits,
        idempotency_key, memo
    )
    values (
        p_player_id, 'withdrawal', -p_amount_credits,
        v_balance - p_amount_credits,
        'withdrawal:' || p_idempotency_key,
        coalesce(p_memo, '')
    );

    return query select (v_balance - p_amount_credits), false;
end;
$$;

revoke all on function public.process_verified_withdrawal(uuid, text, text, text, text, text, bigint, integer, bigint, text, text)
    from public, anon, authenticated;
grant execute on function public.process_verified_withdrawal(uuid, text, text, text, text, text, bigint, integer, bigint, text, text)
    to service_role;
