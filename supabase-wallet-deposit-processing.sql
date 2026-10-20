-- Apply after supabase-wallet.sql. This migration keeps deposits disabled by default.
alter table public.wallet_system_config
    drop constraint if exists wallet_system_config_deposits_enabled_check;

alter table public.wallet_system_config
    add constraint wallet_system_config_deposits_enabled_check
    check (deposits_enabled in (true, false));

alter table public.wallet_system_config
    add column if not exists paid_gameplay_enabled boolean not null default false;

update public.wallet_system_config
set rounding_policy = 'floor',
    deposits_enabled = false,
    paid_gameplay_enabled = false,
    updated_at = now()
where id = 1;

alter table public.wallet_credit_ledger
    drop constraint if exists wallet_credit_ledger_entry_type_check;

alter table public.wallet_credit_ledger
    add constraint wallet_credit_ledger_entry_type_check
    check (entry_type in ('deposit', 'game_entry', 'game_refund', 'game_reward', 'adjustment'));

create table if not exists public.wallet_level_sessions (
    id uuid primary key default gen_random_uuid(),
    player_id uuid not null references public.player_profiles (id) on delete cascade,
    entry_request_id uuid not null,
    level_number integer not null check (level_number between 1 and 99),
    entry_cost_credits bigint not null check (entry_cost_credits > 0),
    created_at timestamptz not null default now(),
    timer_started_at timestamptz,
    expires_at timestamptz not null default (now() + interval '24 hours'),
    completed_at timestamptz,
    stars integer check (stars between 1 and 3),
    solve_duration_ms bigint check (solve_duration_ms >= 0),
    reward_credits bigint not null default 0 check (reward_credits >= 0),
    unique (id, player_id)
);

alter table public.wallet_level_sessions
    add column if not exists solve_duration_ms bigint check (solve_duration_ms >= 0);
alter table public.wallet_level_sessions
    add column if not exists entry_request_id uuid;

create unique index if not exists wallet_level_sessions_player_request_idx
    on public.wallet_level_sessions (player_id, entry_request_id)
    where entry_request_id is not null;

create index if not exists wallet_level_sessions_player_active_idx
    on public.wallet_level_sessions (player_id, created_at desc)
    where completed_at is null;

alter table public.wallet_level_sessions enable row level security;
revoke all on public.wallet_level_sessions from public, anon, authenticated;
grant select, insert, update on public.wallet_level_sessions to service_role;

create or replace function public.apply_wallet_ledger_entry(
    p_player_id uuid,
    p_entry_type text,
    p_amount_credits bigint,
    p_idempotency_key text,
    p_deposit_id uuid default null,
    p_memo text default ''
)
returns table (balance_credits bigint, already_applied boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_existing public.wallet_credit_ledger%rowtype;
    v_deposit public.wallet_deposits%rowtype;
    v_balance bigint;
    v_new_balance bigint;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null
       or p_entry_type is null
       or p_entry_type not in ('deposit', 'game_entry', 'game_refund', 'game_reward', 'adjustment')
       or p_amount_credits is null or p_amount_credits = 0
       or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
        raise exception 'Invalid wallet ledger entry.' using errcode = '22023';
    end if;
    if (p_entry_type = 'deposit') <> (p_deposit_id is not null) then
        raise exception 'Deposit ledger entries must reference one deposit.' using errcode = '22023';
    end if;

    select * into v_existing
    from public.wallet_credit_ledger
    where idempotency_key = p_idempotency_key;

    if found then
        if v_existing.player_id <> p_player_id
           or v_existing.entry_type <> p_entry_type
           or v_existing.amount_credits <> p_amount_credits
           or v_existing.deposit_id is distinct from p_deposit_id then
            raise exception 'Idempotency key was reused for a different wallet entry.' using errcode = '23505';
        end if;
        select a.balance_credits into v_balance
        from public.wallet_credit_accounts as a
        where a.player_id = p_player_id;
        return query select v_balance, true;
        return;
    end if;

    if p_entry_type = 'deposit' then
        if p_amount_credits < 0 then
            raise exception 'Deposit credits must be positive.' using errcode = '22023';
        end if;
        select * into v_deposit
        from public.wallet_deposits as d
        where d.id = p_deposit_id
        for update;
        if not found
           or v_deposit.player_id <> p_player_id
           or v_deposit.status <> 'confirmed'
           or v_deposit.credited_at is not null then
            raise exception 'Deposit is not eligible for crediting.' using errcode = '22023';
        end if;
    end if;

    insert into public.wallet_credit_accounts (player_id)
    values (p_player_id)
    on conflict (player_id) do nothing;

    select a.balance_credits into v_balance
    from public.wallet_credit_accounts as a
    where a.player_id = p_player_id
    for update;

    v_new_balance := v_balance + p_amount_credits;
    if v_new_balance < 0 then
        raise exception 'Insufficient credits.' using errcode = '22023';
    end if;

    insert into public.wallet_credit_ledger (
        player_id, deposit_id, entry_type, amount_credits,
        balance_after_credits, idempotency_key, memo
    )
    values (
        p_player_id, p_deposit_id, p_entry_type, p_amount_credits,
        v_new_balance, p_idempotency_key, coalesce(p_memo, '')
    );

    update public.wallet_credit_accounts as a
    set balance_credits = v_new_balance, updated_at = now()
    where a.player_id = p_player_id;

    if p_entry_type = 'deposit' then
        update public.wallet_deposits as d
        set credit_amount_credits = p_amount_credits,
            credited_at = now()
        where d.id = p_deposit_id;
    end if;

    return query select v_new_balance, false;
end;
$$;

revoke all on function public.apply_wallet_ledger_entry(uuid, text, bigint, text, uuid, text)
    from public, anon, authenticated;
grant execute on function public.apply_wallet_ledger_entry(uuid, text, bigint, text, uuid, text)
    to service_role;

drop function if exists public.start_wallet_level(uuid, integer);

create or replace function public.start_wallet_level(
    p_player_id uuid,
    p_level_number integer,
    p_request_id uuid
)
returns table (session_id uuid, balance_credits bigint, entry_cost_credits bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_config public.wallet_system_config%rowtype;
    v_level_session uuid;
    v_balance bigint;
    v_cost bigint;
    v_unlocked integer;
    v_existing_session public.wallet_level_sessions%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null or p_level_number is null or p_level_number not between 1 and 99
       or p_request_id is null then
        raise exception 'Invalid player or level.' using errcode = '22023';
    end if;

    select * into v_config
    from public.wallet_system_config
    where id = 1
    for share;
    if not found or not v_config.paid_gameplay_enabled then
        raise exception 'Paid gameplay is disabled.' using errcode = '55000';
    end if;
    if v_config.credits_per_token <> 10000 then
        raise exception 'Wallet conversion configuration is invalid.' using errcode = '22023';
    end if;

    perform 1 from public.player_profiles where id = p_player_id for update;
    if not found then
        raise exception 'Player profile was not found.' using errcode = 'P0002';
    end if;

    select * into v_existing_session
    from public.wallet_level_sessions
    where player_id = p_player_id
      and entry_request_id = p_request_id
    for update;
    if found then
        if v_existing_session.level_number <> p_level_number
           or v_existing_session.expires_at <= now()
           or v_existing_session.completed_at is not null then
            raise exception 'Entry request was already used.' using errcode = '22023';
        end if;
        select balance_credits into v_balance
        from public.wallet_credit_accounts
        where player_id = p_player_id;
        return query select v_existing_session.id, v_balance, v_existing_session.entry_cost_credits;
        return;
    end if;

    select least(99, coalesce(min(candidate.level_number), 100))
    into v_unlocked
    from generate_series(1, 99) as candidate(level_number)
    where not exists (
        select 1
        from public.level_completions as completion
        where completion.player_id = p_player_id
          and completion.level_number = candidate.level_number
    );
    if p_level_number > v_unlocked then
        raise exception 'Level is locked.' using errcode = '22023';
    end if;

    v_cost := floor(100 * power(1.08::numeric, p_level_number - 1))::bigint;
    insert into public.wallet_credit_accounts (player_id)
    values (p_player_id) on conflict (player_id) do nothing;
    select balance_credits into v_balance
    from public.wallet_credit_accounts
    where player_id = p_player_id for update;
    if v_balance < v_cost then
        raise exception 'Insufficient credits.' using errcode = 'P0001';
    end if;

    insert into public.wallet_level_sessions (player_id, entry_request_id, level_number, entry_cost_credits)
    values (p_player_id, p_request_id, p_level_number, v_cost)
    returning id into v_level_session;

    select result.balance_credits into v_balance
    from public.apply_wallet_ledger_entry(
        p_player_id, 'game_entry', -v_cost,
        'level-entry:' || v_level_session::text, null,
        'Paid entry to level ' || p_level_number::text
    ) as result;
    return query select v_level_session, v_balance, v_cost;
end;
$$;

create or replace function public.start_wallet_level_timer(
    p_player_id uuid,
    p_session_id uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_started_at timestamptz;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    update public.wallet_level_sessions
    set timer_started_at = coalesce(timer_started_at, now())
    where id = p_session_id
      and player_id = p_player_id
      and completed_at is null
      and expires_at > now()
    returning timer_started_at into v_started_at;
    if not found then
        raise exception 'Level session is invalid or expired.' using errcode = '22023';
    end if;
    return v_started_at;
end;
$$;

drop function if exists public.complete_wallet_level(uuid, uuid, integer, bigint);

create or replace function public.complete_wallet_level(
    p_player_id uuid,
    p_session_id uuid,
    p_stars integer,
    p_reward_credits bigint,
    p_elapsed_milliseconds bigint
)
returns table (
    balance_credits bigint,
    stars integer,
    reward_credits bigint,
    elapsed_milliseconds bigint,
    already_completed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_session public.wallet_level_sessions%rowtype;
    v_expected_reward bigint;
    v_balance bigint;
    v_first_completion boolean;
    v_inserted_rows integer;
    v_already_completed boolean := false;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null or p_session_id is null
       or p_stars is null or p_stars not between 1 and 3
       or p_reward_credits is null or p_reward_credits < 0
       or p_elapsed_milliseconds is null or p_elapsed_milliseconds < 0 then
        raise exception 'Invalid level completion.' using errcode = '22023';
    end if;

    select * into v_session
    from public.wallet_level_sessions
    where id = p_session_id and player_id = p_player_id
    for update;
    if not found then
        raise exception 'Level session was not found.' using errcode = 'P0002';
    end if;

    if v_session.completed_at is not null then
        select balance_credits into v_balance
        from public.wallet_credit_accounts where player_id = p_player_id;
        return query select v_balance, v_session.stars, v_session.reward_credits,
                            v_session.solve_duration_ms, true;
        return;
    end if;
    if v_session.timer_started_at is null or v_session.expires_at <= now() then
        raise exception 'Level session has not started or has expired.' using errcode = '22023';
    end if;

    v_expected_reward := case p_stars
        when 3 then floor(v_session.entry_cost_credits * 1.6)::bigint
        when 2 then floor(v_session.entry_cost_credits * 0.4)::bigint
        else 0
    end;
    if p_reward_credits <> v_expected_reward then
        raise exception 'Reward does not match the tokenomics.' using errcode = '22023';
    end if;

    insert into public.level_completions (player_id, level_number)
    values (p_player_id, v_session.level_number)
    on conflict (player_id, level_number) do nothing;
    get diagnostics v_inserted_rows = row_count;
    v_first_completion := v_inserted_rows = 1;
    if not v_first_completion then
        v_expected_reward := 0;
        v_already_completed := true;
    end if;

    update public.wallet_level_sessions
    set completed_at = now(),
        stars = p_stars,
        solve_duration_ms = p_elapsed_milliseconds,
        reward_credits = v_expected_reward
    where id = p_session_id;

    if v_expected_reward > 0 then
        select result.balance_credits into v_balance
        from public.apply_wallet_ledger_entry(
            p_player_id, 'game_reward', v_expected_reward,
            'level-reward:' || p_session_id::text, null,
            'Level ' || v_session.level_number::text || ' completion reward'
        ) as result;
    else
        select balance_credits into v_balance
        from public.wallet_credit_accounts where player_id = p_player_id;
    end if;
    return query select v_balance, p_stars, v_expected_reward,
                        p_elapsed_milliseconds, v_already_completed;
end;
$$;

revoke all on function public.start_wallet_level(uuid, integer, uuid)
    from public, anon, authenticated;
revoke all on function public.start_wallet_level_timer(uuid, uuid)
    from public, anon, authenticated;
revoke all on function public.complete_wallet_level(uuid, uuid, integer, bigint, bigint)
    from public, anon, authenticated;
grant execute on function public.start_wallet_level(uuid, integer, uuid) to service_role;
grant execute on function public.start_wallet_level_timer(uuid, uuid) to service_role;
grant execute on function public.complete_wallet_level(uuid, uuid, integer, bigint, bigint) to service_role;

create or replace function public.record_level_completion(p_level_number integer)
returns table (completed_levels integer, unlocked_level integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_player_id uuid := auth.uid();
    v_highest_level integer;
    v_paid_gameplay_enabled boolean;
begin
    if v_player_id is null then
        raise exception 'Authentication is required.' using errcode = '42501';
    end if;
    if p_level_number is null or p_level_number < 1 or p_level_number > 99 then
        raise exception 'Level number must be between 1 and 99.' using errcode = '22023';
    end if;

    select paid_gameplay_enabled into v_paid_gameplay_enabled
    from public.wallet_system_config
    where id = 1;
    if v_paid_gameplay_enabled then
        raise exception 'Paid level completions must use the server-verified completion endpoint.'
            using errcode = '42501';
    end if;

    perform 1
    from public.player_profiles
    where id = v_player_id
    for update;
    if not found then
        raise exception 'Player profile was not found.' using errcode = 'P0002';
    end if;

    select coalesce(max(completion.level_number), 0)
    into v_highest_level
    from public.level_completions as completion
    where completion.player_id = v_player_id;
    if p_level_number > v_highest_level + 1 then
        raise exception 'Complete levels in order before recording this level.' using errcode = '22023';
    end if;

    insert into public.level_completions (player_id, level_number)
    values (v_player_id, p_level_number)
    on conflict (player_id, level_number) do nothing;

    return query
    select count(*)::integer,
           least(99, coalesce(max(completion.level_number), 0) + 1)::integer
    from public.level_completions as completion
    where completion.player_id = v_player_id;
end;
$$;

revoke all on function public.record_level_completion(integer) from public, anon;
grant execute on function public.record_level_completion(integer) to authenticated;

create or replace function public.process_verified_wallet_deposit(
    p_player_id uuid,
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
    v_address public.player_deposit_addresses%rowtype;
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
       or v_config.credits_per_token <> 10000
       or v_config.rounding_policy <> 'floor' then
        raise exception 'Deposit configuration is disabled or does not match.' using errcode = '22023';
    end if;

    select * into v_address
    from public.player_deposit_addresses
    where player_id = p_player_id
      and deposit_address = p_deposit_address
      and is_active
    for share;
    if not found then
        raise exception 'Deposit address is not assigned to this player.' using errcode = '22023';
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
        if not found or v_deposit.player_id <> p_player_id then
            raise exception 'Transaction signature has already been processed.' using errcode = '23505';
        end if;
        if v_deposit.status <> 'confirmed' or v_deposit.credited_at is null then
            raise exception 'Previously recorded deposit is not credited.' using errcode = '22023';
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
        'Finalized Solana token deposit'
    ) as result;

    return query select v_balance, v_already_applied;
end;
$$;

revoke all on function public.process_verified_wallet_deposit(
    uuid, text, text, text, text, text, numeric, integer, bigint, bigint
) from public, anon, authenticated;
grant execute on function public.process_verified_wallet_deposit(
    uuid, text, text, text, text, text, numeric, integer, bigint, bigint
) to service_role;
