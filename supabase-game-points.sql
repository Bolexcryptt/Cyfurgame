-- Apply after supabase-wallet-deposit-processing.sql.
-- RelicGrid game points are separate from wallet credits and are not withdrawable.

create table if not exists public.game_point_accounts (
    player_id uuid primary key references public.player_profiles (id) on delete cascade,
    balance_points bigint not null default 0
        check (balance_points between 0 and 9007199254740991),
    updated_at timestamptz not null default now()
);

create table if not exists public.game_point_ledger (
    id bigint generated always as identity primary key,
    player_id uuid not null references public.player_profiles (id) on delete cascade,
    entry_type text not null check (entry_type in ('link_claim', 'game_entry', 'game_reward')),
    amount_points bigint not null check (amount_points <> 0),
    idempotency_key text not null unique,
    created_at timestamptz not null default now()
);

create table if not exists public.game_point_level_sessions (
    id uuid primary key default gen_random_uuid(),
    player_id uuid not null references public.player_profiles (id) on delete cascade,
    entry_request_id uuid not null,
    level_number integer not null check (level_number between 1 and 99),
    entry_cost_points bigint not null check (entry_cost_points > 0),
    created_at timestamptz not null default now(),
    timer_started_at timestamptz,
    expires_at timestamptz not null default (now() + interval '24 hours'),
    completed_at timestamptz,
    stars integer check (stars between 1 and 3),
    solve_duration_ms bigint check (solve_duration_ms >= 0),
    reward_points bigint not null default 0 check (reward_points >= 0),
    unique (id, player_id),
    unique (player_id, entry_request_id)
);

create index if not exists game_point_level_sessions_player_active_idx
    on public.game_point_level_sessions (player_id, created_at desc)
    where completed_at is null;

create table if not exists public.game_point_level_completions (
    player_id uuid not null references public.player_profiles (id) on delete cascade,
    level_number integer not null check (level_number between 1 and 99),
    session_id uuid not null unique,
    stars integer not null check (stars between 1 and 3),
    reward_points bigint not null check (reward_points >= 0),
    solve_duration_ms bigint not null check (solve_duration_ms >= 0),
    completed_at timestamptz not null default now(),
    primary key (player_id, level_number),
    foreign key (session_id, player_id)
        references public.game_point_level_sessions (id, player_id) on delete cascade
);

alter table public.game_point_accounts enable row level security;
alter table public.game_point_ledger enable row level security;
alter table public.game_point_level_sessions enable row level security;
alter table public.game_point_level_completions enable row level security;

revoke all on public.game_point_accounts, public.game_point_ledger,
    public.game_point_level_sessions, public.game_point_level_completions
    from public, anon, authenticated;
grant select, insert, update on public.game_point_accounts to service_role;
grant select, insert on public.game_point_ledger to service_role;
grant select, insert, update on public.game_point_level_sessions to service_role;
grant select, insert on public.game_point_level_completions to service_role;
grant usage, select on sequence public.game_point_ledger_id_seq to service_role;

create or replace function public.start_game_point_level(
    p_player_id uuid,
    p_level_number integer,
    p_request_id uuid
)
returns table (session_id uuid, balance_points bigint, entry_cost_points bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_session public.game_point_level_sessions%rowtype;
    v_active_session public.game_point_level_sessions%rowtype;
    v_balance bigint;
    v_cost bigint;
    v_new_session uuid;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null or p_request_id is null
       or p_level_number is null or p_level_number not between 1 and 99 then
        raise exception 'Invalid level entry request.' using errcode = '22023';
    end if;

    perform 1 from public.player_profiles where id = p_player_id for update;
    if not found then
        raise exception 'Player profile was not found.' using errcode = 'P0002';
    end if;

    v_cost := floor(100 * power(1.08::numeric, p_level_number - 1))::bigint;
    insert into public.game_point_accounts (player_id) values (p_player_id)
    on conflict (player_id) do nothing;
    select balance_points into v_balance
    from public.game_point_accounts where player_id = p_player_id for update;

    select * into v_session
    from public.game_point_level_sessions
    where player_id = p_player_id and entry_request_id = p_request_id
    for update;
    if found then
        if v_session.level_number <> p_level_number then
            raise exception 'Entry request ID was already used for another level.'
                using errcode = '22023';
        end if;
        return query select v_session.id, v_balance, v_session.entry_cost_points;
        return;
    end if;

    select * into v_active_session
    from public.game_point_level_sessions
    where player_id = p_player_id
      and completed_at is null
      and expires_at > now()
    order by created_at desc
    limit 1
    for update;
    if found then
        raise exception 'Another level session is already active.' using errcode = '55006';
    end if;

    if v_balance < v_cost then
        raise exception 'Insufficient game points.' using errcode = 'P0001';
    end if;

    insert into public.game_point_level_sessions (
        player_id, entry_request_id, level_number, entry_cost_points
    )
    values (p_player_id, p_request_id, p_level_number, v_cost)
    returning id into v_new_session;

    update public.game_point_accounts
    set balance_points = balance_points - v_cost,
        updated_at = now()
    where player_id = p_player_id
    returning balance_points into v_balance;

    insert into public.game_point_ledger (
        player_id, entry_type, amount_points, idempotency_key
    )
    values (p_player_id, 'game_entry', -v_cost, 'level-entry:' || v_new_session::text);

    return query select v_new_session, v_balance, v_cost;
end;
$$;

create or replace function public.start_game_point_level_timer(
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
    update public.game_point_level_sessions
    set timer_started_at = coalesce(timer_started_at, now())
    where id = p_session_id
      and player_id = p_player_id
      and completed_at is null
      and expires_at > now()
    returning timer_started_at into v_started_at;
    if not found then
        raise exception 'Game-points level session is unavailable.' using errcode = 'P0002';
    end if;
    return v_started_at;
end;
$$;

create or replace function public.complete_game_point_level(
    p_player_id uuid,
    p_session_id uuid,
    p_stars integer,
    p_reward_points bigint,
    p_elapsed_milliseconds bigint
)
returns table (
    balance_points bigint,
    stars integer,
    reward_points bigint,
    elapsed_milliseconds bigint,
    already_completed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_session public.game_point_level_sessions%rowtype;
    v_expected_reward bigint;
    v_balance bigint;
    v_inserted_rows integer;
    v_already_completed boolean := false;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null or p_session_id is null
       or p_stars is null or p_stars not between 1 and 3
       or p_reward_points is null or p_reward_points < 0
       or p_elapsed_milliseconds is null or p_elapsed_milliseconds < 0 then
        raise exception 'Invalid level completion.' using errcode = '22023';
    end if;

    select * into v_session
    from public.game_point_level_sessions
    where id = p_session_id and player_id = p_player_id
    for update;
    if not found then
        raise exception 'Game-points level session was not found.' using errcode = 'P0002';
    end if;

    if v_session.completed_at is not null then
        select balance_points into v_balance
        from public.game_point_accounts where player_id = p_player_id;
        return query select v_balance, v_session.stars, v_session.reward_points,
                            v_session.solve_duration_ms, true;
        return;
    end if;
    if v_session.timer_started_at is null or v_session.expires_at <= now() then
        raise exception 'Game-points level session has not started or has expired.' using errcode = '22023';
    end if;

    v_expected_reward := case p_stars
        when 3 then floor(v_session.entry_cost_points * 1.6)::bigint
        when 2 then floor(v_session.entry_cost_points * 0.4)::bigint
        else 0
    end;
    if p_reward_points <> v_expected_reward then
        raise exception 'Reward does not match the RelicGrid point rules.' using errcode = '22023';
    end if;

    insert into public.game_point_level_completions (
        player_id, level_number, session_id, stars, reward_points, solve_duration_ms
    )
    values (
        p_player_id, v_session.level_number, p_session_id, p_stars,
        v_expected_reward, p_elapsed_milliseconds
    )
    on conflict (player_id, level_number) do nothing;
    get diagnostics v_inserted_rows = row_count;
    if v_inserted_rows = 0 then
        v_expected_reward := 0;
        v_already_completed := true;
    end if;

    update public.game_point_level_sessions
    set completed_at = now(),
        stars = p_stars,
        solve_duration_ms = p_elapsed_milliseconds,
        reward_points = v_expected_reward
    where id = p_session_id;

    if v_expected_reward > 0 then
        update public.game_point_accounts
        set balance_points = balance_points + v_expected_reward,
            updated_at = now()
        where player_id = p_player_id
        returning balance_points into v_balance;
        insert into public.game_point_ledger (
            player_id, entry_type, amount_points, idempotency_key
        )
        values (
            p_player_id, 'game_reward', v_expected_reward, 'level-reward:' || p_session_id::text
        );
    else
        select balance_points into v_balance
        from public.game_point_accounts where player_id = p_player_id;
    end if;
    return query select v_balance, p_stars, v_expected_reward,
                        p_elapsed_milliseconds, v_already_completed;
end;
$$;

revoke all on function public.start_game_point_level(uuid, integer, uuid)
    from public, anon, authenticated;
revoke all on function public.start_game_point_level_timer(uuid, uuid)
    from public, anon, authenticated;
revoke all on function public.complete_game_point_level(uuid, uuid, integer, bigint, bigint)
    from public, anon, authenticated;
grant execute on function public.start_game_point_level(uuid, integer, uuid) to service_role;
grant execute on function public.start_game_point_level_timer(uuid, uuid) to service_role;
grant execute on function public.complete_game_point_level(uuid, uuid, integer, bigint, bigint)
    to service_role;
