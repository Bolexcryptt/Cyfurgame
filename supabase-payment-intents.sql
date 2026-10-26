-- Apply after supabase-direct-treasury-deposits.sql.
-- Deposit and paid-gameplay switches remain disabled.

create table if not exists public.wallet_payment_intents (
    id uuid primary key,
    player_id uuid not null references public.player_profiles (id) on delete cascade,
    source_wallet_address text,
    network text not null check (network in ('devnet', 'mainnet-beta')),
    mint_address text not null,
    token_program_id text not null,
    treasury_address text not null,
    amount_raw numeric not null check (amount_raw > 0 and amount_raw = trunc(amount_raw)),
    token_decimals integer not null check (token_decimals between 0 and 18),
    created_at timestamptz not null,
    expires_at timestamptz not null,
    status text not null default 'pending' check (status in ('pending', 'confirmed')),
    transaction_signature text,
    finalized_slot bigint,
    finalized_at timestamptz,
    constraint wallet_payment_intents_signature_unique unique (network, transaction_signature),
    constraint wallet_payment_intents_confirmation_check check (
        (status = 'pending' and transaction_signature is null and finalized_slot is null and finalized_at is null)
        or
        (status = 'confirmed' and transaction_signature is not null and finalized_slot is not null and finalized_at is not null)
    ),
    constraint wallet_payment_intents_expiry_check check (expires_at > created_at)
);

alter table public.wallet_payment_intents enable row level security;
revoke all on public.wallet_payment_intents from public, anon, authenticated;
grant select, insert, update, delete on public.wallet_payment_intents to service_role;
create index if not exists wallet_payment_intents_pending_expiry_idx
    on public.wallet_payment_intents (expires_at)
    where status = 'pending';

create or replace function public.process_verified_payment_intent(
    p_payment_intent_id uuid,
    p_player_id uuid,
    p_source_wallet_address text,
    p_network text,
    p_transaction_signature text,
    p_mint_address text,
    p_token_program_id text,
    p_deposit_address text,
    p_amount_raw numeric,
    p_token_decimals integer,
    p_finalized_slot bigint,
    p_finalized_at timestamptz,
    p_credit_amount_credits bigint
)
returns table (balance_credits bigint, already_applied boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_intent public.wallet_payment_intents%rowtype;
    v_balance bigint;
    v_already_applied boolean;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_payment_intent_id is null
       or p_player_id is null
       or p_source_wallet_address is null
       or p_network is null
       or p_transaction_signature is null
       or p_mint_address is null
       or p_token_program_id is null
       or p_deposit_address is null
       or p_amount_raw is null
       or p_token_decimals is null
       or p_finalized_slot is null
       or p_finalized_at is null
       or p_credit_amount_credits is null then
        raise exception 'Invalid verified payment intent.' using errcode = '22023';
    end if;

    select * into v_intent
    from public.wallet_payment_intents
    where id = p_payment_intent_id
    for update;
    if not found
       or v_intent.player_id <> p_player_id
       or (v_intent.source_wallet_address is not null
           and v_intent.source_wallet_address <> p_source_wallet_address)
       or v_intent.network <> p_network
       or v_intent.mint_address <> p_mint_address
       or v_intent.token_program_id <> p_token_program_id
       or v_intent.treasury_address <> p_deposit_address
       or v_intent.amount_raw > p_amount_raw
       or v_intent.token_decimals <> p_token_decimals
       or p_finalized_at < v_intent.created_at - interval '30 seconds'
       or p_finalized_at > v_intent.expires_at then
        raise exception 'Payment does not match an unexpired player intent.' using errcode = '22023';
    end if;

    if v_intent.status = 'confirmed'
       and v_intent.transaction_signature <> p_transaction_signature then
        raise exception 'Payment intent was already consumed.' using errcode = '23505';
    end if;

    select result.balance_credits, result.already_applied
    into v_balance, v_already_applied
    from public.process_verified_treasury_deposit(
        p_player_id,
        p_source_wallet_address,
        p_network,
        p_transaction_signature,
        p_mint_address,
        p_token_program_id,
        p_deposit_address,
        p_amount_raw,
        p_token_decimals,
        p_finalized_slot,
        p_credit_amount_credits
    ) as result;

    if v_intent.status = 'pending' then
        update public.wallet_payment_intents
        set status = 'confirmed',
            transaction_signature = p_transaction_signature,
            finalized_slot = p_finalized_slot,
            finalized_at = p_finalized_at
        where id = p_payment_intent_id;
    end if;

    return query select v_balance, v_already_applied;
end;
$$;

revoke all on function public.process_verified_payment_intent(
    uuid, uuid, text, text, text, text, text, text, numeric, integer, bigint, timestamptz, bigint
) from public, anon, authenticated;
grant execute on function public.process_verified_payment_intent(
    uuid, uuid, text, text, text, text, text, text, numeric, integer, bigint, timestamptz, bigint
) to service_role;
