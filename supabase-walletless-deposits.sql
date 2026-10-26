-- Apply after supabase-payment-intents.sql to enable authenticated,
-- non-custodial deposits from any Solana wallet without linking it to the game.
-- Deposit and paid-gameplay switches remain disabled.

alter table public.wallet_payment_intents
    alter column source_wallet_address drop not null;
update public.wallet_payment_intents
set source_wallet_address = null
where status = 'pending';

create or replace function public.process_verified_treasury_deposit(
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
    p_credit_amount_credits bigint
)
returns table (balance_credits bigint, already_applied boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_config public.wallet_system_config%rowtype;
    v_deposit public.wallet_deposits%rowtype;
    v_deposit_id uuid;
    v_expected_credits numeric;
    v_balance bigint;
    v_already_applied boolean;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null
       or p_source_wallet_address is null
       or p_network is null
       or p_network not in ('devnet', 'mainnet-beta')
       or p_transaction_signature is null
       or char_length(p_transaction_signature) not between 80 and 100
       or p_mint_address is null
       or p_token_program_id is null
       or p_deposit_address is null
       or p_amount_raw is null or p_amount_raw <= 0 or p_amount_raw <> trunc(p_amount_raw)
       or p_token_decimals is null or p_token_decimals not between 0 and 18
       or p_finalized_slot is null or p_finalized_slot <= 0
       or p_credit_amount_credits is null or p_credit_amount_credits <= 0 then
        raise exception 'Invalid verified deposit.' using errcode = '22023';
    end if;

    select * into v_config
    from public.wallet_system_config
    where id = 1
    for share;
    if not found
       or not v_config.deposits_enabled
       or v_config.network <> p_network
       or v_config.official_mint_address <> p_mint_address
       or v_config.token_program_id <> p_token_program_id
       or v_config.token_decimals <> p_token_decimals
       or v_config.treasury_address is distinct from p_deposit_address
       or v_config.credits_per_token <> 10000
       or v_config.rounding_policy <> 'floor' then
        raise exception 'Deposit configuration is disabled or does not match.' using errcode = '22023';
    end if;

    v_expected_credits := floor(
        p_amount_raw * v_config.credits_per_token
        / power(10::numeric, v_config.token_decimals)
    );
    if v_expected_credits <= 0
       or v_expected_credits > 9223372036854775807 then
        raise exception 'Deposit credit amount is outside the supported range.' using errcode = '22003';
    end if;
    if v_expected_credits::bigint <> p_credit_amount_credits then
        raise exception 'Deposit credit amount does not match the configured conversion.' using errcode = '22023';
    end if;

    insert into public.wallet_deposits (
        player_id, network, transaction_signature, mint_address, token_program_id,
        deposit_address, amount_raw, token_decimals, finalized_slot, status, confirmed_at
    )
    values (
        p_player_id, p_network, p_transaction_signature, p_mint_address, p_token_program_id,
        p_deposit_address, p_amount_raw, p_token_decimals, p_finalized_slot, 'confirmed', now()
    )
    on conflict (network, transaction_signature) do nothing
    returning id into v_deposit_id;

    if v_deposit_id is null then
        select * into v_deposit
        from public.wallet_deposits
        where network = p_network
          and transaction_signature = p_transaction_signature
        for update;
        if not found
           or v_deposit.player_id <> p_player_id
           or v_deposit.mint_address <> p_mint_address
           or v_deposit.token_program_id <> p_token_program_id
           or v_deposit.deposit_address <> p_deposit_address
           or v_deposit.amount_raw <> p_amount_raw
           or v_deposit.token_decimals <> p_token_decimals
           or v_deposit.finalized_slot <> p_finalized_slot
           or v_deposit.status <> 'confirmed'
           or v_deposit.credited_at is null then
            raise exception 'Transaction signature has already been processed or does not match.' using errcode = '23505';
        end if;
        select a.balance_credits into v_balance
        from public.wallet_credit_accounts as a
        where a.player_id = p_player_id;
        return query select v_balance, true;
        return;
    end if;

    select result.balance_credits, result.already_applied
    into v_balance, v_already_applied
    from public.apply_wallet_ledger_entry(
        p_player_id,
        'deposit',
        p_credit_amount_credits,
        'deposit:' || p_network || ':' || p_transaction_signature,
        v_deposit_id,
        'Finalized direct-to-treasury Solana deposit'
    ) as result;

    return query select v_balance, v_already_applied;
end;
$$;

revoke all on function public.process_verified_treasury_deposit(
    uuid, text, text, text, text, text, text, numeric, integer, bigint, bigint
) from public, anon, authenticated;
grant execute on function public.process_verified_treasury_deposit(
    uuid, text, text, text, text, text, text, numeric, integer, bigint, bigint
) to service_role;

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
