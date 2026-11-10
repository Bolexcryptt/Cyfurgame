-- Apply after supabase-game-points-cyfur-deposits.sql and
-- supabase-shared-treasury-deposit-attribution.sql.
-- Transaction IDs are verified against Solana and attributed to the authenticated
-- player submitting them. Existing balances and deposit history are preserved.

create or replace function public.process_verified_transaction_deposit(
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
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null
       or p_source_wallet_address is null
       or p_network is null
       or p_transaction_signature is null
       or p_mint_address is null
       or p_token_program_id is null
       or p_deposit_address is null
       or p_amount_raw is null
       or p_token_decimals is null
       or p_finalized_slot is null
       or p_credit_amount_credits is null then
        raise exception 'Invalid verified transaction deposit.' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_transaction_signature, 0));

    if exists (
        select 1
        from public.game_point_transaction_claims as claims
        where claims.transaction_signature = p_transaction_signature
    ) then
        raise exception 'Transaction ID was already used for game points.'
            using errcode = '23505';
    end if;

    if exists (
        select 1
        from public.wallet_deposits as deposits
        where deposits.transaction_signature = p_transaction_signature
          and deposits.network <> p_network
    ) then
        raise exception 'Transaction ID was already recorded on another network.'
            using errcode = '23505';
    end if;

    return query
    select result.balance_credits, result.already_applied
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
end;
$$;

revoke all on function public.process_verified_transaction_deposit(
    uuid, text, text, text, text, text, text, numeric, integer, bigint, bigint
) from public, anon, authenticated;
grant execute on function public.process_verified_transaction_deposit(
    uuid, text, text, text, text, text, text, numeric, integer, bigint, bigint
) to service_role;

notify pgrst, 'reload schema';
