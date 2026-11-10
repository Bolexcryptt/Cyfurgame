-- Apply after supabase-game-points-verified-claims.sql and the wallet deposit migrations.
-- Existing balances and historical transaction claims are intentionally preserved.

alter table public.game_point_transaction_claims
    add column if not exists amount_raw numeric(78, 0),
    add column if not exists token_decimals integer;

do $$
declare
    v_constraint_name text;
begin
    select conname into v_constraint_name
    from pg_constraint
    where conrelid = 'public.game_point_ledger'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%entry_type%';

    if v_constraint_name is not null then
        execute format('alter table public.game_point_ledger drop constraint %I', v_constraint_name);
    end if;
end;
$$;

alter table public.game_point_ledger
    add constraint game_point_ledger_entry_type_check
    check (entry_type in ('link_claim', 'cyfur_deposit', 'game_entry', 'game_reward'));

create or replace function public.prevent_reusing_game_point_deposit_signature()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform pg_advisory_xact_lock(hashtextextended(NEW.transaction_signature, 0));
    if exists (
        select 1
        from public.game_point_transaction_claims as claims
        where claims.transaction_signature = NEW.transaction_signature
    ) then
        raise exception 'Transaction signature was already used for game points.'
            using errcode = '23505';
    end if;
    return NEW;
end;
$$;

drop trigger if exists wallet_deposits_prevent_game_point_reuse
    on public.wallet_deposits;
create trigger wallet_deposits_prevent_game_point_reuse
before insert or update of network, transaction_signature
on public.wallet_deposits
for each row
execute function public.prevent_reusing_game_point_deposit_signature();

drop function if exists public.claim_verified_game_points(uuid, text, text, bigint);

create or replace function public.credit_verified_cyfur_game_points(
    p_player_id uuid,
    p_transaction_signature text,
    p_network text,
    p_finalized_slot bigint,
    p_amount_raw numeric,
    p_token_decimals integer,
    p_mint_address text,
    p_token_program_id text,
    p_treasury_address text
)
returns table (balance_points bigint, already_claimed boolean, amount_points bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_balance bigint;
    v_claimed_rows integer;
    v_ledger_rows integer;
    v_amount_points numeric;
    v_config public.wallet_system_config%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null
       or p_transaction_signature is null
       or p_transaction_signature !~ '^[1-9A-HJ-NP-Za-km-z]{80,100}$'
       or p_network is null
       or p_network not in ('devnet', 'mainnet-beta')
       or p_finalized_slot is null
       or p_finalized_slot <= 0
       or p_amount_raw is null
       or p_amount_raw <= 0
       or p_amount_raw <> trunc(p_amount_raw)
       or p_amount_raw > 18446744073709551615
       or p_token_decimals is null
       or p_token_decimals not between 0 and 18
       or p_mint_address is null
       or p_token_program_id is null
       or p_treasury_address is null then
        raise exception 'Invalid verified CYFUR deposit.' using errcode = '22023';
    end if;

    select * into v_config
    from public.wallet_system_config
    where id = 1
    for share;
    if not found
       or v_config.network <> p_network
       or v_config.official_mint_address <> p_mint_address
       or v_config.token_program_id <> p_token_program_id
       or v_config.token_decimals <> p_token_decimals
       or v_config.treasury_address is distinct from p_treasury_address
       or p_mint_address <> '9F4hLLngEAhepsH2HLTH6kBYmmq6dzm4GXRrcpME3uam'
       or p_token_program_id <> 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
       or p_treasury_address <> '6KTSpvxGR2xvje3BG42QvmFjg2XLnFneCCSyVXhSKvys'
       or v_config.credits_per_token <> 1000
       or v_config.rounding_policy <> 'floor' then
        raise exception 'CYFUR game-point deposit configuration does not match.'
            using errcode = '22023';
    end if;

    v_amount_points := floor(p_amount_raw * 1000 / power(10::numeric, p_token_decimals));
    if v_amount_points <= 0 or v_amount_points > 9223372036854775807 then
        raise exception 'CYFUR deposit is outside the supported game-points range.'
            using errcode = '22003';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_transaction_signature, 0));
    if exists (
        select 1
        from public.wallet_deposits as deposits
        where deposits.transaction_signature = p_transaction_signature
    ) then
        raise exception 'Transaction signature was already recorded as a wallet deposit.'
            using errcode = '23505';
    end if;

    perform 1 from public.player_profiles where id = p_player_id for update;
    if not found then
        raise exception 'Player profile was not found.' using errcode = 'P0002';
    end if;
    insert into public.game_point_accounts (player_id)
    values (p_player_id)
    on conflict (player_id) do nothing;
    perform 1 from public.game_point_accounts where player_id = p_player_id for update;

    insert into public.game_point_transaction_claims (
        transaction_signature, player_id, network, finalized_slot, amount_raw, token_decimals
    )
    values (
        p_transaction_signature, p_player_id, p_network, p_finalized_slot, p_amount_raw, p_token_decimals
    )
    on conflict (transaction_signature) do nothing;
    get diagnostics v_claimed_rows = row_count;

    if v_claimed_rows = 1 then
        insert into public.game_point_ledger (
            player_id, entry_type, amount_points, idempotency_key
        )
        values (
            p_player_id,
            'cyfur_deposit',
            v_amount_points::bigint,
            'cyfur-deposit:' || p_network || ':' || p_transaction_signature
        )
        on conflict (idempotency_key) do nothing;
        get diagnostics v_ledger_rows = row_count;
        if v_ledger_rows <> 1 then
            raise exception 'CYFUR deposit ledger entry already exists.' using errcode = '23505';
        end if;

        update public.game_point_accounts
        set balance_points = balance_points + v_amount_points::bigint,
            updated_at = now()
        where player_id = p_player_id
        returning game_point_accounts.balance_points into v_balance;
        return query select v_balance, false, v_amount_points::bigint;
        return;
    end if;

    select accounts.balance_points into v_balance
    from public.game_point_accounts as accounts
    where accounts.player_id = p_player_id;
    return query select v_balance, true, v_amount_points::bigint;
end;
$$;

revoke all on function public.prevent_reusing_game_point_deposit_signature()
    from public, anon, authenticated;
revoke all on function public.credit_verified_cyfur_game_points(uuid, text, text, bigint, numeric, integer, text, text, text)
    from public, anon, authenticated;
grant execute on function public.credit_verified_cyfur_game_points(uuid, text, text, bigint, numeric, integer, text, text, text)
    to service_role;

notify pgrst, 'reload schema';
