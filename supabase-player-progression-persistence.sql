-- Apply after supabase-unified-player-balance.sql.
-- This migration changes progression metadata only; it does not touch wallet balances or ledgers.

alter table public.player_profiles
    add column if not exists current_level integer not null default 1;

do $$
begin
    if not exists (
        select 1
        from pg_catalog.pg_constraint
        where conrelid = 'public.player_profiles'::regclass
          and conname = 'player_profiles_current_level_check'
    ) then
        alter table public.player_profiles
            add constraint player_profiles_current_level_check
            check (current_level between 1 and 99);
    end if;
end;
$$;

with reached_levels as (
    select session.player_id, session.level_number as current_level
    from public.wallet_level_sessions as session
    union all
    select completion.player_id, least(99, completion.level_number + 1)
    from public.level_completions as completion
    union all
    select session.player_id, session.level_number
    from public.game_point_level_sessions as session
    union all
    select completion.player_id, least(99, completion.level_number + 1)
    from public.game_point_level_completions as completion
),
saved_progress as (
    select profile.id as player_id,
           greatest(1, coalesce(max(reached.current_level), 1)) as current_level
    from public.player_profiles as profile
    left join reached_levels as reached on reached.player_id = profile.id
    group by profile.id
)
update public.player_profiles as profile
set current_level = greatest(profile.current_level, saved.current_level)
from saved_progress as saved
where profile.id = saved.player_id
  and profile.current_level < saved.current_level;

create or replace function public.prevent_player_progress_regression()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.current_level < old.current_level then
        raise exception 'Player progression cannot move backwards.' using errcode = '22023';
    end if;
    return new;
end;
$$;

revoke all on function public.prevent_player_progress_regression() from public, anon, authenticated;

drop trigger if exists player_profiles_current_level_monotonic
    on public.player_profiles;
create trigger player_profiles_current_level_monotonic
    before update of current_level on public.player_profiles
    for each row execute function public.prevent_player_progress_regression();

create or replace function public.advance_player_progress_from_level_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.player_profiles
    set current_level = greatest(current_level, new.level_number)
    where id = new.player_id;
    if not found then
        raise exception 'Player profile was not found.' using errcode = 'P0002';
    end if;
    return new;
end;
$$;

revoke all on function public.advance_player_progress_from_level_session()
    from public, anon, authenticated;

drop trigger if exists wallet_level_sessions_advance_player_progress
    on public.wallet_level_sessions;
create trigger wallet_level_sessions_advance_player_progress
    after insert on public.wallet_level_sessions
    for each row execute function public.advance_player_progress_from_level_session();

create or replace function public.advance_player_progress_from_level_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.player_profiles
    set current_level = greatest(current_level, least(99, new.level_number + 1))
    where id = new.player_id;
    if not found then
        raise exception 'Player profile was not found.' using errcode = 'P0002';
    end if;
    return new;
end;
$$;

revoke all on function public.advance_player_progress_from_level_completion()
    from public, anon, authenticated;

drop trigger if exists level_completions_advance_player_progress
    on public.level_completions;
create trigger level_completions_advance_player_progress
    after insert on public.level_completions
    for each row execute function public.advance_player_progress_from_level_completion();
