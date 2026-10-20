create table if not exists public.player_profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    display_name text not null default '' check (char_length(display_name) <= 20),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.level_completions (
    player_id uuid not null references public.player_profiles (id) on delete cascade,
    level_number integer not null check (level_number between 1 and 99),
    completed_at timestamptz not null default now(),
    primary key (player_id, level_number)
);

create index if not exists level_completions_leaderboard_idx
    on public.level_completions (level_number, player_id);

alter table public.player_profiles enable row level security;
alter table public.level_completions enable row level security;

drop policy if exists "Authenticated players can view leaderboard profiles"
    on public.player_profiles;
create policy "Authenticated players can view leaderboard profiles"
    on public.player_profiles for select to authenticated using (true);

drop policy if exists "Authenticated players can view leaderboard completions"
    on public.level_completions;
create policy "Authenticated players can view leaderboard completions"
    on public.level_completions for select to authenticated using (true);

create or replace function public.create_player_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.player_profiles (id)
    values (new.id)
    on conflict (id) do nothing;
    return new;
end;
$$;

revoke all on function public.create_player_profile() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_fluxgrid_profile on auth.users;
create trigger on_auth_user_created_fluxgrid_profile
    after insert on auth.users
    for each row execute function public.create_player_profile();

insert into public.player_profiles (id)
select id from auth.users
on conflict (id) do nothing;

create or replace function public.set_player_display_name(p_display_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_player_id uuid := auth.uid();
    v_name text := btrim(p_display_name);
begin
    if v_player_id is null then
        raise exception 'Authentication is required.' using errcode = '42501';
    end if;
    if v_name is null or char_length(v_name) < 1 or char_length(v_name) > 20 then
        raise exception 'Callsign must contain between 1 and 20 characters.' using errcode = '22023';
    end if;

    update public.player_profiles
    set display_name = v_name, updated_at = now()
    where id = v_player_id;

    if not found then
        raise exception 'Player profile was not found.' using errcode = 'P0002';
    end if;
    return v_name;
end;
$$;

create or replace function public.record_level_completion(p_level_number integer)
returns table (completed_levels integer, unlocked_level integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_player_id uuid := auth.uid();
    v_highest_level integer;
begin
    if v_player_id is null then
        raise exception 'Authentication is required.' using errcode = '42501';
    end if;
    if p_level_number is null or p_level_number < 1 or p_level_number > 99 then
        raise exception 'Level number must be between 1 and 99.' using errcode = '22023';
    end if;

    perform 1
    from public.player_profiles
    where id = v_player_id
    for update;
    if not found then
        raise exception 'Player profile was not found.' using errcode = 'P0002';
    end if;

    select coalesce(max(c.level_number), 0)
    into v_highest_level
    from public.level_completions as c
    where c.player_id = v_player_id;

    if p_level_number > v_highest_level + 1 then
        raise exception 'Complete levels in order before recording this level.' using errcode = '22023';
    end if;

    insert into public.level_completions (player_id, level_number)
    values (v_player_id, p_level_number)
    on conflict (player_id, level_number) do nothing;

    return query
    select count(*)::integer, least(99, coalesce(max(c.level_number), 0) + 1)::integer
    from public.level_completions as c
    where c.player_id = v_player_id;
end;
$$;

revoke all on function public.set_player_display_name(text) from public, anon;
revoke all on function public.record_level_completion(integer) from public, anon;
grant execute on function public.set_player_display_name(text) to authenticated;
grant execute on function public.record_level_completion(integer) to authenticated;

create or replace view public.fluxgrid_leaderboard
with (security_invoker = true)
as
select
    row_number() over (
        order by count(c.level_number) desc, lower(p.display_name), p.created_at, p.id
    )::integer as rank,
    p.id as player_id,
    coalesce(nullif(p.display_name, ''), 'Pilot') as display_name,
    count(c.level_number)::integer as levels_completed,
    coalesce(max(c.level_number), 0)::integer as highest_level,
    p.created_at
from public.player_profiles as p
left join public.level_completions as c on c.player_id = p.id
group by p.id, p.display_name, p.created_at;

grant select on public.fluxgrid_leaderboard to authenticated;
