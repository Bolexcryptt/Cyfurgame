-- Apply after supabase-wallet-deposit-processing.sql.
-- Direct treasury deposits replace provider-managed player deposit addresses.
-- Payment switches deliberately remain disabled.

alter table public.wallet_system_config
    add column if not exists treasury_address text;

update public.wallet_system_config
set deposits_enabled = false,
    paid_gameplay_enabled = false,
    updated_at = now()
where id = 1;

create table if not exists public.player_solana_wallets (
    player_id uuid primary key references public.player_profiles (id) on delete cascade,
    wallet_address text not null unique,
    verified_at timestamptz not null default now()
);

create table if not exists public.wallet_link_challenges (
    player_id uuid primary key references public.player_profiles (id) on delete cascade,
    challenge text not null unique,
    expires_at timestamptz not null
);

alter table public.player_solana_wallets enable row level security;
alter table public.wallet_link_challenges enable row level security;

revoke all on public.player_solana_wallets from public, anon, authenticated;
revoke all on public.wallet_link_challenges from public, anon, authenticated;
grant select on public.player_solana_wallets to authenticated;
grant select, insert, update, delete on public.player_solana_wallets to service_role;
grant select, insert, update, delete on public.wallet_link_challenges to service_role;

drop policy if exists "Players can view their linked Solana wallet"
    on public.player_solana_wallets;
create policy "Players can view their linked Solana wallet"
    on public.player_solana_wallets for select to authenticated
    using (player_id = (select auth.uid()));

create or replace function public.link_player_solana_wallet(
    p_player_id uuid,
    p_wallet_address text,
    p_challenge text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_challenge public.wallet_link_challenges%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null
       or p_wallet_address is null
       or char_length(p_wallet_address) not between 32 and 44
       or p_challenge is null then
        raise exception 'Invalid Solana wallet proof.' using errcode = '22023';
    end if;

    select * into v_challenge
    from public.wallet_link_challenges
    where player_id = p_player_id
      and challenge = p_challenge
      and expires_at > now()
    for update;
    if not found then
        raise exception 'Wallet proof has expired or was already used.' using errcode = '22023';
    end if;

    delete from public.wallet_link_challenges
    where player_id = p_player_id;

    insert into public.player_solana_wallets (player_id, wallet_address, verified_at)
    values (p_player_id, p_wallet_address, now())
    on conflict (player_id) do update
        set wallet_address = excluded.wallet_address,
            verified_at = excluded.verified_at;
end;
$$;

revoke all on function public.link_player_solana_wallet(uuid, text, text)
    from public, anon, authenticated;
grant execute on function public.link_player_solana_wallet(uuid, text, text)
    to service_role;

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
