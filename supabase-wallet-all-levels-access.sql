-- Apply after supabase-wallet-level-entry-safety.sql.
-- Opens paid level selection in any order; each entry remains balance-checked and charged.
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
    v_existing_session public.wallet_level_sessions%rowtype;
    v_active_session public.wallet_level_sessions%rowtype;
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
    if v_config.credits_per_token <> 1000 then
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

    select * into v_active_session
    from public.wallet_level_sessions
    where player_id = p_player_id
      and completed_at is null
      and expires_at > now()
    order by created_at desc
    limit 1
    for update;
    if found then
        if v_active_session.level_number <> p_level_number then
            raise exception 'Another level session is already active.' using errcode = '55006';
        end if;
        select balance_credits into v_balance
        from public.wallet_credit_accounts
        where player_id = p_player_id;
        return query select v_active_session.id, v_balance, v_active_session.entry_cost_credits;
        return;
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

revoke all on function public.start_wallet_level(uuid, integer, uuid)
    from public, anon, authenticated;
grant execute on function public.start_wallet_level(uuid, integer, uuid)
    to service_role;
