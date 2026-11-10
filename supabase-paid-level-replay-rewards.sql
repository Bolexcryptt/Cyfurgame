-- Apply after supabase-wallet-deposit-processing.sql and supabase-game-points.sql.
-- New paid sessions may earn their own reward; existing balances and completion rows are unchanged.

create table if not exists public.game_point_level_reward_claims (
    session_id uuid primary key,
    player_id uuid not null,
    level_number integer not null check (level_number between 1 and 99),
    stars integer not null check (stars between 1 and 3),
    reward_points bigint not null check (reward_points >= 0),
    solve_duration_ms bigint not null check (solve_duration_ms >= 0),
    claimed_at timestamptz not null default now(),
    foreign key (session_id, player_id)
        references public.game_point_level_sessions (id, player_id) on delete cascade
);

alter table public.game_point_level_reward_claims enable row level security;
revoke all on public.game_point_level_reward_claims from public, anon, authenticated;
grant select, insert on public.game_point_level_reward_claims to service_role;

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
        select account.balance_credits into v_balance
        from public.wallet_credit_accounts as account
        where account.player_id = p_player_id;
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
        select account.balance_credits into v_balance
        from public.wallet_credit_accounts as account
        where account.player_id = p_player_id;
    end if;
    return query select v_balance, p_stars, v_expected_reward,
                        p_elapsed_milliseconds, v_already_completed;
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

    insert into public.game_point_level_reward_claims (
        session_id, player_id, level_number, stars, reward_points, solve_duration_ms
    )
    values (
        p_session_id, p_player_id, v_session.level_number, p_stars,
        v_expected_reward, p_elapsed_milliseconds
    )
    on conflict (session_id) do nothing;
    get diagnostics v_inserted_rows = row_count;
    if v_inserted_rows <> 1 then
        raise exception 'This paid level session has already been claimed.' using errcode = '23505';
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

revoke all on function public.complete_wallet_level(uuid, uuid, integer, bigint, bigint)
    from public, anon, authenticated;
revoke all on function public.complete_game_point_level(uuid, uuid, integer, bigint, bigint)
    from public, anon, authenticated;
grant execute on function public.complete_wallet_level(uuid, uuid, integer, bigint, bigint)
    to service_role;
grant execute on function public.complete_game_point_level(uuid, uuid, integer, bigint, bigint)
    to service_role;
