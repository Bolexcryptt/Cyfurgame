-- Apply after supabase-unified-player-balance.sql.
-- Atomically forfeits the active level session and starts the next paid level.
create or replace function public.skip_wallet_level(
    p_player_id uuid,
    p_session_id uuid,
    p_next_level_number integer,
    p_request_id uuid,
    p_layout_seed bigint
)
returns table (
    session_id uuid,
    balance_credits bigint,
    entry_cost_credits bigint,
    layout_seed bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_session public.wallet_level_sessions%rowtype;
    v_next_session public.wallet_level_sessions%rowtype;
    v_balance bigint;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null or p_session_id is null or p_request_id is null
       or p_next_level_number is null or p_next_level_number not between 2 and 99
       or p_layout_seed is null or p_layout_seed not between 0 and 4294967295 then
        raise exception 'Invalid player, session, level, request, or layout seed.' using errcode = '22023';
    end if;

    perform 1 from public.player_profiles where id = p_player_id for update;
    if not found then
        raise exception 'Player profile was not found.' using errcode = 'P0002';
    end if;

    select * into v_next_session
    from public.wallet_level_sessions
    where player_id = p_player_id and entry_request_id = p_request_id
    for update;
    if found then
        if v_next_session.level_number <> p_next_level_number
           or v_next_session.completed_at is not null
           or v_next_session.expires_at <= now() then
            raise exception 'Skip request was already used.' using errcode = '22023';
        end if;
        select account.balance_credits into v_balance
        from public.wallet_credit_accounts as account
        where account.player_id = p_player_id;
        return query select v_next_session.id, v_balance,
            v_next_session.entry_cost_credits, v_next_session.layout_seed;
        return;
    end if;

    select * into v_session
    from public.wallet_level_sessions
    where id = p_session_id and player_id = p_player_id
    for update;
    if not found or v_session.completed_at is not null
       or v_session.expires_at <= now()
       or v_session.level_number + 1 <> p_next_level_number then
        raise exception 'Active level session cannot be skipped.' using errcode = '22023';
    end if;

    update public.wallet_level_sessions
    set expires_at = now()
    where id = p_session_id and player_id = p_player_id
      and completed_at is null and expires_at > now();
    if not found then
        raise exception 'Active level session cannot be skipped.' using errcode = '22023';
    end if;

    return query
    select started.session_id, started.balance_credits,
        started.entry_cost_credits, started.layout_seed
    from public.start_wallet_level(
        p_player_id, p_next_level_number, p_request_id, p_layout_seed
    ) as started;
end;
$$;

revoke all on function public.skip_wallet_level(uuid, uuid, integer, uuid, bigint)
    from public, anon, authenticated;
grant execute on function public.skip_wallet_level(uuid, uuid, integer, uuid, bigint)
    to service_role;
