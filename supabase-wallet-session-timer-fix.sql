-- Apply after the wallet level-session schema is installed.
-- Starts the paid solve timer when the player first interacts with the puzzle,
-- including when resuming an existing uncompleted paid session.
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
    if p_player_id is null or p_session_id is null then
        raise exception 'Invalid level session.' using errcode = '22023';
    end if;

    update public.wallet_level_sessions
    set timer_started_at = now()
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

revoke all on function public.start_wallet_level_timer(uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.start_wallet_level_timer(uuid, uuid)
    to service_role;
