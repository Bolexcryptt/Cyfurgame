-- Apply after supabase-wallet.sql and the direct-treasury wallet setup.
-- This migration only adds withdrawal metadata and RPCs. Existing balances,
-- game scores, progress, and leaderboard rows are not reset or rewritten.

alter table public.wallet_system_config
    add column if not exists withdrawals_enabled boolean not null default false;

alter table public.wallet_system_config
    add column if not exists withdrawal_rate_limit_per_hour integer not null default 5;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'public.wallet_system_config'::regclass
          and conname = 'wallet_system_config_withdrawal_rate_limit_check'
    ) then
        alter table public.wallet_system_config
            add constraint wallet_system_config_withdrawal_rate_limit_check
            check (withdrawal_rate_limit_per_hour = 5);
    end if;
end;
$$;

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
    network text,
    mint_address text,
    token_program_id text,
    treasury_address text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    confirmed_at timestamptz
);

alter table public.wallet_withdrawals
    add column if not exists network text,
    add column if not exists mint_address text,
    add column if not exists token_program_id text,
    add column if not exists treasury_address text;

alter table public.wallet_credit_ledger
    drop constraint if exists wallet_credit_ledger_entry_type_check;

alter table public.wallet_credit_ledger
    add constraint wallet_credit_ledger_entry_type_check
        check (entry_type in (
            'deposit',
            'game_entry',
            'game_refund',
            'adjustment',
            'withdrawal_reserve',
            'withdrawal_release'
        ));

alter table public.wallet_credit_ledger
    drop constraint if exists wallet_credit_ledger_withdrawal_sign_check;

alter table public.wallet_credit_ledger
    add constraint wallet_credit_ledger_withdrawal_sign_check
        check (
            (entry_type <> 'withdrawal_reserve' or amount_credits < 0)
            and (entry_type <> 'withdrawal_release' or amount_credits > 0)
        );

alter table public.wallet_withdrawals enable row level security;
revoke all on public.wallet_withdrawals from public, anon, authenticated;
grant select on public.wallet_withdrawals to authenticated;
revoke insert, update, delete on public.wallet_withdrawals from service_role;
grant select on public.wallet_withdrawals to service_role;

drop policy if exists "Players can view their own withdrawals"
    on public.wallet_withdrawals;
create policy "Players can view their own withdrawals"
    on public.wallet_withdrawals for select to authenticated
    using (player_id = (select auth.uid()));

create index if not exists wallet_withdrawals_player_idx
    on public.wallet_withdrawals (player_id, created_at desc);

create or replace function public.reserve_wallet_withdrawal(
    p_player_id uuid,
    p_wallet_address text,
    p_network text,
    p_mint_address text,
    p_token_program_id text,
    p_treasury_address text,
    p_amount_raw bigint,
    p_token_decimals integer,
    p_amount_credits bigint,
    p_idempotency_key text,
    p_memo text default ''
)
returns table (
    withdrawal_id uuid,
    withdrawal_status text,
    transaction_signature text,
    balance_credits bigint,
    already_reserved boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_config public.wallet_system_config%rowtype;
    v_existing public.wallet_withdrawals%rowtype;
    v_balance bigint;
    v_new_balance bigint;
    v_withdrawal_id uuid;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null
       or p_wallet_address is null or char_length(p_wallet_address) not between 32 and 44
       or p_network is null or p_network not in ('devnet', 'mainnet-beta')
       or p_mint_address is null
       or p_token_program_id is null
       or p_treasury_address is null
       or p_amount_raw is null or p_amount_raw <= 0
       or p_token_decimals is null or p_token_decimals not between 0 and 18
       or p_amount_credits is null or p_amount_credits <= 0
       or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
        raise exception 'Invalid withdrawal reservation.' using errcode = '22023';
    end if;

    select * into v_config
    from public.wallet_system_config
    where id = 1
    for share;

    if not found
       or not v_config.withdrawals_enabled
       or v_config.network is distinct from p_network
       or v_config.official_mint_address is distinct from p_mint_address
       or v_config.token_program_id is distinct from p_token_program_id
       or v_config.token_decimals is distinct from p_token_decimals
       or v_config.treasury_address is distinct from p_treasury_address
       or v_config.credits_per_token is distinct from 1000
       or v_config.rounding_policy is distinct from 'floor'
       or v_config.withdrawal_rate_limit_per_hour is distinct from 5
       or floor(p_amount_raw::numeric * v_config.credits_per_token
            / power(10::numeric, v_config.token_decimals)) <> p_amount_credits then
        raise exception 'Withdrawal configuration or amount does not match the approved database settings.'
            using errcode = '22023';
    end if;

    insert into public.wallet_credit_accounts (player_id)
    values (p_player_id)
    on conflict (player_id) do nothing;

    select a.balance_credits into v_balance
    from public.wallet_credit_accounts as a
    where a.player_id = p_player_id
    for update;

    select * into v_existing
    from public.wallet_withdrawals
    where idempotency_key = p_idempotency_key
    for update;

    if found then
        if v_existing.player_id <> p_player_id
           or v_existing.wallet_address <> p_wallet_address
           or v_existing.network is distinct from p_network
           or v_existing.mint_address is distinct from p_mint_address
           or v_existing.token_program_id is distinct from p_token_program_id
           or v_existing.treasury_address is distinct from p_treasury_address
           or v_existing.amount_credits <> p_amount_credits
           or v_existing.amount_raw <> p_amount_raw
           or v_existing.token_decimals <> p_token_decimals then
            raise exception 'Idempotency key was reused for a different withdrawal.' using errcode = '23505';
        end if;
        return query select v_existing.id, v_existing.status,
            v_existing.transaction_signature, v_balance, true;
        return;
    end if;

    if exists (
        select 1
        from public.wallet_withdrawals as w
        where w.player_id = p_player_id
          and w.status in ('pending', 'submitted')
    ) then
        raise exception 'A withdrawal is already pending reconciliation.' using errcode = '23505';
    end if;
    if v_balance < p_amount_credits then
        raise exception 'Insufficient credits for withdrawal.' using errcode = '22023';
    end if;

    v_new_balance := v_balance - p_amount_credits;
    insert into public.wallet_withdrawals (
        player_id, wallet_address, amount_credits, amount_raw, token_decimals,
        status, idempotency_key, memo, network, mint_address, token_program_id,
        treasury_address, updated_at
    )
    values (
        p_player_id, p_wallet_address, p_amount_credits, p_amount_raw, p_token_decimals,
        'pending', p_idempotency_key, coalesce(p_memo, ''), p_network, p_mint_address,
        p_token_program_id, p_treasury_address, now()
    )
    returning id into v_withdrawal_id;

    insert into public.wallet_credit_ledger (
        player_id, entry_type, amount_credits, balance_after_credits,
        idempotency_key, memo
    )
    values (
        p_player_id, 'withdrawal_reserve', -p_amount_credits,
        v_new_balance, 'withdrawal-reserve:' || v_withdrawal_id::text,
        coalesce(p_memo, '')
    );

    update public.wallet_credit_accounts
    set balance_credits = v_new_balance, updated_at = now()
    where player_id = p_player_id;

    return query select v_withdrawal_id, 'pending'::text, null::text, v_new_balance, false;
end;
$$;

create or replace function public.enforce_wallet_withdrawal_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_rate_limit integer;
    v_recent_count integer;
begin
    perform pg_advisory_xact_lock(
        hashtextextended('withdrawal-rate:' || new.player_id::text, 0)
    );

    select withdrawal_rate_limit_per_hour into v_rate_limit
    from public.wallet_system_config
    where id = 1
    for share;
    if v_rate_limit is distinct from 5 then
        raise exception 'Withdrawal request rate limit configuration is invalid.'
            using errcode = '22023';
    end if;

    select count(*) into v_recent_count
    from public.wallet_withdrawals as w
    where w.player_id = new.player_id
      and w.created_at > now() - interval '1 hour';
    if v_recent_count >= v_rate_limit then
        raise exception 'Withdrawal request rate limit exceeded.' using errcode = 'P0001';
    end if;
    return new;
end;
$$;

revoke all on function public.enforce_wallet_withdrawal_rate_limit()
    from public, anon, authenticated, service_role;

drop trigger if exists wallet_withdrawals_rate_limit
    on public.wallet_withdrawals;
create trigger wallet_withdrawals_rate_limit
    before insert on public.wallet_withdrawals
    for each row execute function public.enforce_wallet_withdrawal_rate_limit();

create or replace function public.mark_wallet_withdrawal_submitted(
    p_withdrawal_id uuid,
    p_transaction_signature text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.wallet_withdrawals%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_withdrawal_id is null or p_transaction_signature is null
       or char_length(p_transaction_signature) not between 80 and 100 then
        raise exception 'Invalid submitted withdrawal.' using errcode = '22023';
    end if;

    select * into v_row
    from public.wallet_withdrawals
    where id = p_withdrawal_id
    for update;
    if not found then
        raise exception 'Withdrawal reservation was not found.' using errcode = 'P0002';
    end if;
    if v_row.status = 'submitted'
       and v_row.transaction_signature = p_transaction_signature then
        return;
    end if;
    if v_row.status <> 'pending' or v_row.transaction_signature is not null then
        raise exception 'Withdrawal cannot transition to submitted.' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_transaction_signature, 0));
    if exists (
        select 1
        from public.wallet_withdrawals as w
        where w.transaction_signature = p_transaction_signature
          and w.id <> p_withdrawal_id
    ) then
        raise exception 'Transaction signature is already linked to another withdrawal.'
            using errcode = '23505';
    end if;

    update public.wallet_withdrawals
    set status = 'submitted',
        transaction_signature = p_transaction_signature,
        updated_at = now()
    where id = p_withdrawal_id;
end;
$$;

create or replace function public.confirm_wallet_withdrawal(
    p_withdrawal_id uuid,
    p_transaction_signature text
)
returns table (balance_credits bigint, already_confirmed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.wallet_withdrawals%rowtype;
    v_balance bigint;
    v_reservation public.wallet_credit_ledger%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_withdrawal_id is null or p_transaction_signature is null then
        raise exception 'Invalid withdrawal confirmation.' using errcode = '22023';
    end if;

    select * into v_row
    from public.wallet_withdrawals
    where id = p_withdrawal_id
    for update;
    if not found or v_row.transaction_signature is distinct from p_transaction_signature then
        raise exception 'Withdrawal signature does not match the submitted request.' using errcode = '22023';
    end if;
    if v_row.status = 'confirmed' then
        select a.balance_credits into v_balance
        from public.wallet_credit_accounts as a
        where a.player_id = v_row.player_id;
        return query select v_balance, true;
        return;
    end if;
    if v_row.status <> 'submitted' then
        raise exception 'Only a submitted withdrawal can be confirmed.' using errcode = '22023';
    end if;

    select * into v_reservation
    from public.wallet_credit_ledger
    where idempotency_key = 'withdrawal-reserve:' || v_row.id::text;
    if not found
       or v_reservation.player_id <> v_row.player_id
       or v_reservation.amount_credits <> -v_row.amount_credits then
        raise exception 'Withdrawal balance reservation is missing or inconsistent.' using errcode = '22023';
    end if;

    update public.wallet_withdrawals
    set status = 'confirmed', confirmed_at = now(), updated_at = now()
    where id = p_withdrawal_id;

    select a.balance_credits into v_balance
    from public.wallet_credit_accounts as a
    where a.player_id = v_row.player_id;
    return query select v_balance, false;
end;
$$;

create or replace function public.release_wallet_withdrawal(
    p_withdrawal_id uuid,
    p_failure_reason text,
    p_chain_failure_verified boolean default false,
    p_transaction_signature text default null
)
returns table (balance_credits bigint, already_released boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.wallet_withdrawals%rowtype;
    v_balance bigint;
    v_new_balance bigint;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_withdrawal_id is null or p_failure_reason is null
       or char_length(p_failure_reason) not between 1 and 500 then
        raise exception 'Invalid withdrawal release.' using errcode = '22023';
    end if;

    select * into v_row
    from public.wallet_withdrawals
    where id = p_withdrawal_id
    for update;
    if not found then
        raise exception 'Withdrawal reservation was not found.' using errcode = 'P0002';
    end if;
    if v_row.status = 'failed' then
        select a.balance_credits into v_balance
        from public.wallet_credit_accounts as a
        where a.player_id = v_row.player_id;
        return query select v_balance, true;
        return;
    end if;
    if v_row.status = 'pending' then
        if v_row.transaction_signature is not null then
            raise exception 'A withdrawal with a transaction signature cannot be released without chain verification.'
                using errcode = '22023';
        end if;
    elsif v_row.status = 'submitted' then
        if p_chain_failure_verified is distinct from true
           or v_row.transaction_signature is distinct from p_transaction_signature then
            raise exception 'Submitted withdrawal funds can only be released after verifying the transaction failed.'
                using errcode = '22023';
        end if;
    else
        raise exception 'This withdrawal reservation cannot be released.' using errcode = '22023';
    end if;

    select a.balance_credits into v_balance
    from public.wallet_credit_accounts as a
    where a.player_id = v_row.player_id
    for update;
    if v_balance > 9223372036854775807 - v_row.amount_credits then
        raise exception 'Released balance exceeds the supported range.' using errcode = '22003';
    end if;
    v_new_balance := v_balance + v_row.amount_credits;

    insert into public.wallet_credit_ledger (
        player_id, entry_type, amount_credits, balance_after_credits,
        idempotency_key, memo
    )
    values (
        v_row.player_id, 'withdrawal_release', v_row.amount_credits,
        v_new_balance, 'withdrawal-release:' || v_row.id::text,
        'Release of withdrawal ' || v_row.id::text
    );

    update public.wallet_credit_accounts
    set balance_credits = v_new_balance, updated_at = now()
    where player_id = v_row.player_id;

    update public.wallet_withdrawals
    set status = 'failed',
        failure_reason = left(p_failure_reason, 500),
        updated_at = now()
    where id = p_withdrawal_id;

    return query select v_new_balance, false;
end;
$$;

revoke all on function public.reserve_wallet_withdrawal(uuid, text, text, text, text, text, bigint, integer, bigint, text, text)
    from public, anon, authenticated;
revoke all on function public.mark_wallet_withdrawal_submitted(uuid, text)
    from public, anon, authenticated;
revoke all on function public.confirm_wallet_withdrawal(uuid, text)
    from public, anon, authenticated;
revoke all on function public.release_wallet_withdrawal(uuid, text, boolean, text)
    from public, anon, authenticated;

grant execute on function public.reserve_wallet_withdrawal(uuid, text, text, text, text, text, bigint, integer, bigint, text, text)
    to service_role;
grant execute on function public.mark_wallet_withdrawal_submitted(uuid, text)
    to service_role;
grant execute on function public.confirm_wallet_withdrawal(uuid, text)
    to service_role;
grant execute on function public.release_wallet_withdrawal(uuid, text, boolean, text)
    to service_role;

drop function if exists public.process_verified_withdrawal(uuid, text, text, text, text, text, bigint, integer, bigint, text, text);

notify pgrst, 'reload schema';
