-- Apply after the existing wallet, withdrawal, and game-point migrations.
-- Legacy game-point rows remain intact; their balance and ledger effects are
-- copied once, 1:1, into the canonical wallet-credit account.

begin;

alter table public.wallet_level_sessions
    add column if not exists layout_seed bigint
    check (layout_seed between 0 and 4294967295);

alter table public.wallet_credit_ledger
    add column if not exists source_system text,
    add column if not exists source_ledger_id text,
    add column if not exists source_created_at timestamptz;

create unique index if not exists wallet_credit_ledger_source_idx
    on public.wallet_credit_ledger (source_system, source_ledger_id)
    where source_system is not null and source_ledger_id is not null;

alter table public.wallet_withdrawals
    add column if not exists balance_deducted boolean not null default false;

update public.wallet_withdrawals as withdrawal
set balance_deducted = true
where withdrawal.status in ('pending', 'submitted', 'confirmed')
  and exists (
      select 1
      from public.wallet_credit_ledger as ledger
      where ledger.idempotency_key = 'withdrawal-reserve:' || withdrawal.id::text
        and ledger.amount_credits = -withdrawal.amount_credits
  );

alter table public.wallet_credit_ledger
    drop constraint if exists wallet_credit_ledger_entry_type_check;
alter table public.wallet_credit_ledger
    add constraint wallet_credit_ledger_entry_type_check
    check (entry_type in (
        'deposit', 'game_entry', 'game_refund', 'adjustment',
        'withdrawal_reserve', 'withdrawal_release', 'withdrawal'
    ));
alter table public.wallet_credit_ledger
    drop constraint if exists wallet_credit_ledger_withdrawal_sign_check;
alter table public.wallet_credit_ledger
    add constraint wallet_credit_ledger_withdrawal_sign_check
    check (
        (entry_type <> 'withdrawal_reserve' or amount_credits < 0)
        and (entry_type <> 'withdrawal_release' or amount_credits > 0)
        and (entry_type <> 'withdrawal' or amount_credits < 0)
    );

create table if not exists public.wallet_balance_migration_audit (
    player_id uuid primary key,
    source_balance_points bigint not null,
    source_ledger_total numeric not null,
    reconciliation_points numeric not null,
    wallet_balance_before bigint not null,
    wallet_balance_after bigint not null,
    migrated_at timestamptz not null default now()
);

revoke all on public.wallet_balance_migration_audit from public, anon, authenticated;
grant select on public.wallet_balance_migration_audit to service_role;

do $$
declare
    v_point record;
    v_entry record;
    v_wallet_balance bigint;
    v_running_balance bigint;
    v_amount bigint;
    v_ledger_total numeric;
    v_reconciliation numeric;
    v_final_balance bigint;
begin
    if to_regclass('public.game_point_accounts') is null
       or to_regclass('public.game_point_ledger') is null then
        raise exception 'Apply the game-point schema before unifying player balances.';
    end if;

    lock table public.game_point_accounts, public.game_point_ledger,
        public.game_point_transaction_claims, public.game_point_level_sessions,
        public.game_point_level_completions, public.game_point_level_reward_claims,
        public.wallet_credit_accounts, public.wallet_credit_ledger
        in share row exclusive mode;

    if exists (
        select 1
        from public.game_point_ledger as ledger
        left join public.game_point_accounts as account on account.player_id = ledger.player_id
        where account.player_id is null
    ) then
        raise exception 'A game-point ledger exists without its account; review the data before migration.';
    end if;

    if exists (
        select 1
        from public.wallet_credit_ledger as ledger
        where ledger.source_system in ('game_points', 'game_points_balance')
          and not exists (
              select 1 from public.wallet_balance_migration_audit as audit
              where audit.player_id = ledger.player_id
          )
    ) then
        raise exception 'Partial game-point migration records exist without an audit row.';
    end if;

    for v_point in
        select account.player_id, account.balance_points
        from public.game_point_accounts as account
        where not exists (
            select 1 from public.wallet_balance_migration_audit as audit
            where audit.player_id = account.player_id
        )
        order by account.player_id
        for update
    loop
        if v_point.balance_points < 0 then
            raise exception 'A game-point account has a negative balance; migration stopped.';
        end if;

        insert into public.wallet_credit_accounts (player_id)
        values (v_point.player_id)
        on conflict (player_id) do nothing;

        select account.balance_credits into v_wallet_balance
        from public.wallet_credit_accounts as account
        where account.player_id = v_point.player_id
        for update;
        v_running_balance := v_wallet_balance;

        for v_entry in
            select ledger.id, ledger.entry_type, ledger.amount_points, ledger.created_at
            from public.game_point_ledger as ledger
            where ledger.player_id = v_point.player_id
            order by ledger.created_at, ledger.id
        loop
            v_amount := v_entry.amount_points;
            v_running_balance := v_running_balance + v_amount;
            if v_running_balance < 0 then
                raise exception 'Game-point ledger for player % would make the unified balance negative.',
                    v_point.player_id;
            end if;

            insert into public.wallet_credit_ledger (
                player_id, entry_type, amount_credits, balance_after_credits,
                idempotency_key, memo, source_system, source_ledger_id, source_created_at
            )
            values (
                v_point.player_id,
                'adjustment',
                v_amount,
                v_running_balance,
                'unified-game-point:' || v_entry.id::text,
                'Unified legacy game-point ' || v_entry.entry_type || ' entry ' || v_entry.id::text,
                'game_points',
                v_entry.id::text,
                v_entry.created_at
            );
        end loop;

        select coalesce(sum(ledger.amount_points), 0)
        into v_ledger_total
        from public.game_point_ledger as ledger
        where ledger.player_id = v_point.player_id;
        v_reconciliation := v_point.balance_points::numeric - v_ledger_total;
        if v_reconciliation <> 0 then
            v_running_balance := v_running_balance + v_reconciliation::bigint;
            if v_running_balance < 0 then
                raise exception 'Game-point balance reconciliation for player % would be negative.',
                    v_point.player_id;
            end if;
            insert into public.wallet_credit_ledger (
                player_id, entry_type, amount_credits, balance_after_credits,
                idempotency_key, memo, source_system, source_ledger_id
            )
            values (
                v_point.player_id,
                'adjustment',
                v_reconciliation::bigint,
                v_running_balance,
                'unified-game-point-balance:' || v_point.player_id::text,
                'Reconcile legacy game-point account balance to its recorded ledger total',
                'game_points_balance',
                v_point.player_id::text
            );
        end if;

        v_final_balance := v_wallet_balance + v_point.balance_points;
        update public.wallet_credit_accounts as account
        set balance_credits = v_final_balance,
            updated_at = now()
        where account.player_id = v_point.player_id;

        insert into public.wallet_balance_migration_audit (
            player_id, source_balance_points, source_ledger_total,
            reconciliation_points, wallet_balance_before, wallet_balance_after
        )
        values (
            v_point.player_id, v_point.balance_points, v_ledger_total,
            v_reconciliation, v_wallet_balance, v_final_balance
        );
    end loop;
end;
$$;

insert into public.level_completions (player_id, level_number, completed_at)
select completion.player_id, completion.level_number, completion.completed_at
from public.game_point_level_completions as completion
on conflict (player_id, level_number) do nothing;

create or replace function public.reject_unified_legacy_game_point_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if exists (
        select 1
        from public.wallet_balance_migration_audit as audit
        where audit.player_id = new.player_id
    ) then
        raise exception 'This player balance has been unified; legacy game-point writes are disabled.'
            using errcode = '55000';
    end if;
    return new;
end;
$$;

drop trigger if exists unified_game_point_accounts_readonly on public.game_point_accounts;
create trigger unified_game_point_accounts_readonly
before insert or update on public.game_point_accounts
for each row execute function public.reject_unified_legacy_game_point_write();

drop trigger if exists unified_game_point_ledger_readonly on public.game_point_ledger;
create trigger unified_game_point_ledger_readonly
before insert or update on public.game_point_ledger
for each row execute function public.reject_unified_legacy_game_point_write();

drop trigger if exists unified_game_point_claims_readonly on public.game_point_transaction_claims;
create trigger unified_game_point_claims_readonly
before insert or update on public.game_point_transaction_claims
for each row execute function public.reject_unified_legacy_game_point_write();

drop trigger if exists unified_game_point_sessions_readonly on public.game_point_level_sessions;
create trigger unified_game_point_sessions_readonly
before insert or update on public.game_point_level_sessions
for each row execute function public.reject_unified_legacy_game_point_write();

drop trigger if exists unified_game_point_completions_readonly on public.game_point_level_completions;
create trigger unified_game_point_completions_readonly
before insert or update on public.game_point_level_completions
for each row execute function public.reject_unified_legacy_game_point_write();

drop trigger if exists unified_game_point_rewards_readonly on public.game_point_level_reward_claims;
create trigger unified_game_point_rewards_readonly
before insert or update on public.game_point_level_reward_claims
for each row execute function public.reject_unified_legacy_game_point_write();

drop function if exists public.start_wallet_level(uuid, integer, uuid);

create or replace function public.start_wallet_level(
    p_player_id uuid,
    p_level_number integer,
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
    v_config public.wallet_system_config%rowtype;
    v_session public.wallet_level_sessions%rowtype;
    v_active_session public.wallet_level_sessions%rowtype;
    v_session_id uuid;
    v_balance bigint;
    v_pending_withdrawal bigint;
    v_cost bigint;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null or p_request_id is null
       or p_level_number is null or p_level_number not between 1 and 99
       or p_layout_seed is null or p_layout_seed not between 0 and 4294967295 then
        raise exception 'Invalid player, level, request, or layout seed.' using errcode = '22023';
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

    select * into v_session
    from public.wallet_level_sessions
    where player_id = p_player_id and entry_request_id = p_request_id
    for update;
    if found then
        if v_session.level_number <> p_level_number
           or v_session.expires_at <= now()
           or v_session.completed_at is not null then
            raise exception 'Entry request was already used.' using errcode = '22023';
        end if;
        select account.balance_credits into v_balance
        from public.wallet_credit_accounts as account
        where account.player_id = p_player_id;
        return query select v_session.id, v_balance, v_session.entry_cost_credits, v_session.layout_seed;
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
        select account.balance_credits into v_balance
        from public.wallet_credit_accounts as account
        where account.player_id = p_player_id;
        return query select v_active_session.id, v_balance,
            v_active_session.entry_cost_credits, v_active_session.layout_seed;
        return;
    end if;

    v_cost := floor(100 * power(1.08::numeric, p_level_number - 1))::bigint;
    insert into public.wallet_credit_accounts (player_id)
    values (p_player_id) on conflict (player_id) do nothing;
    select account.balance_credits into v_balance
    from public.wallet_credit_accounts as account
    where account.player_id = p_player_id for update;
    select coalesce(sum(withdrawal.amount_credits), 0)
    into v_pending_withdrawal
    from public.wallet_withdrawals as withdrawal
    where withdrawal.player_id = p_player_id
      and withdrawal.status in ('pending', 'submitted')
      and withdrawal.balance_deducted = false;
    if v_balance - v_pending_withdrawal < v_cost then
        raise exception 'Insufficient credits.' using errcode = 'P0001';
    end if;

    insert into public.wallet_level_sessions (
        player_id, entry_request_id, level_number, entry_cost_credits,
        layout_seed, timer_started_at
    )
    values (p_player_id, p_request_id, p_level_number, v_cost, p_layout_seed, now())
    returning id into v_session_id;

    select result.balance_credits into v_balance
    from public.apply_wallet_ledger_entry(
        p_player_id, 'game_entry', -v_cost,
        'level-entry:' || v_session_id::text, null,
        'Paid entry to level ' || p_level_number::text
    ) as result;
    return query select v_session_id, v_balance, v_cost, p_layout_seed;
end;
$$;

revoke all on function public.start_wallet_level(uuid, integer, uuid, bigint)
    from public, anon, authenticated;
grant execute on function public.start_wallet_level(uuid, integer, uuid, bigint)
    to service_role;

create or replace function public.reserve_wallet_withdrawal(
    p_player_id uuid,
    p_wallet_address text,
    p_network text,
    p_mint_address text,
    p_token_program_id text,
    p_treasury_address text,
    p_amount_raw bigint,
    p_token_decimals integer,
    p_amount_credits bigint,
    p_idempotency_key text,
    p_memo text default ''
)
returns table (
    withdrawal_id uuid,
    withdrawal_status text,
    transaction_signature text,
    balance_credits bigint,
    already_reserved boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_config public.wallet_system_config%rowtype;
    v_existing public.wallet_withdrawals%rowtype;
    v_balance bigint;
    v_withdrawal_id uuid;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null
       or p_wallet_address is null or char_length(p_wallet_address) not between 32 and 44
       or p_network is null or p_network not in ('devnet', 'mainnet-beta')
       or p_mint_address is null or p_token_program_id is null or p_treasury_address is null
       or p_amount_raw is null or p_amount_raw <= 0
       or p_token_decimals is null or p_token_decimals not between 0 and 18
       or p_amount_credits is null or p_amount_credits <= 0
       or p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
        raise exception 'Invalid withdrawal reservation.' using errcode = '22023';
    end if;

    select * into v_config
    from public.wallet_system_config
    where id = 1
    for share;
    if not found or not v_config.withdrawals_enabled
       or v_config.network is distinct from p_network
       or v_config.official_mint_address is distinct from p_mint_address
       or v_config.token_program_id is distinct from p_token_program_id
       or v_config.token_decimals is distinct from p_token_decimals
       or v_config.treasury_address is distinct from p_treasury_address
       or v_config.credits_per_token is distinct from 1000
       or v_config.rounding_policy is distinct from 'floor'
       or v_config.withdrawal_rate_limit_per_hour is distinct from 5
       or floor(p_amount_raw::numeric * v_config.credits_per_token
            / power(10::numeric, v_config.token_decimals)) <> p_amount_credits then
        raise exception 'Withdrawal configuration or amount does not match the approved database settings.'
            using errcode = '22023';
    end if;

    insert into public.wallet_credit_accounts (player_id)
    values (p_player_id)
    on conflict (player_id) do nothing;
    select account.balance_credits into v_balance
    from public.wallet_credit_accounts as account
    where account.player_id = p_player_id
    for update;

    select * into v_existing
    from public.wallet_withdrawals
    where idempotency_key = p_idempotency_key
    for update;
    if found then
        if v_existing.player_id <> p_player_id
           or v_existing.wallet_address <> p_wallet_address
           or v_existing.network is distinct from p_network
           or v_existing.mint_address is distinct from p_mint_address
           or v_existing.token_program_id is distinct from p_token_program_id
           or v_existing.treasury_address is distinct from p_treasury_address
           or v_existing.amount_credits <> p_amount_credits
           or v_existing.amount_raw <> p_amount_raw
           or v_existing.token_decimals <> p_token_decimals then
            raise exception 'Idempotency key was reused for a different withdrawal.' using errcode = '23505';
        end if;
        return query select v_existing.id, v_existing.status,
            v_existing.transaction_signature, v_balance, true;
        return;
    end if;

    if exists (
        select 1 from public.wallet_withdrawals as withdrawal
        where withdrawal.player_id = p_player_id
          and withdrawal.status in ('pending', 'submitted')
    ) then
        raise exception 'A withdrawal is already pending reconciliation.' using errcode = '23505';
    end if;
    if v_balance < p_amount_credits then
        raise exception 'Insufficient credits for withdrawal.' using errcode = '22023';
    end if;

    insert into public.wallet_withdrawals (
        player_id, wallet_address, amount_credits, amount_raw, token_decimals,
        status, idempotency_key, memo, network, mint_address, token_program_id,
        treasury_address, balance_deducted, updated_at
    )
    values (
        p_player_id, p_wallet_address, p_amount_credits, p_amount_raw, p_token_decimals,
        'pending', p_idempotency_key, coalesce(p_memo, ''), p_network, p_mint_address,
        p_token_program_id, p_treasury_address, false, now()
    )
    returning id into v_withdrawal_id;

    return query select v_withdrawal_id, 'pending'::text, null::text, v_balance, false;
end;
$$;

create or replace function public.confirm_wallet_withdrawal(
    p_withdrawal_id uuid,
    p_transaction_signature text
)
returns table (balance_credits bigint, already_confirmed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.wallet_withdrawals%rowtype;
    v_balance bigint;
    v_new_balance bigint;
    v_reservation public.wallet_credit_ledger%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_withdrawal_id is null or p_transaction_signature is null then
        raise exception 'Invalid withdrawal confirmation.' using errcode = '22023';
    end if;

    select * into v_row
    from public.wallet_withdrawals
    where id = p_withdrawal_id
    for update;
    if not found or v_row.transaction_signature is distinct from p_transaction_signature then
        raise exception 'Withdrawal signature does not match the submitted request.' using errcode = '22023';
    end if;
    if v_row.status = 'confirmed' then
        select account.balance_credits into v_balance
        from public.wallet_credit_accounts as account
        where account.player_id = v_row.player_id;
        return query select v_balance, true;
        return;
    end if;
    if v_row.status <> 'submitted' then
        raise exception 'Only a submitted withdrawal can be confirmed.' using errcode = '22023';
    end if;

    select account.balance_credits into v_balance
    from public.wallet_credit_accounts as account
    where account.player_id = v_row.player_id
    for update;

    if v_row.balance_deducted then
        select * into v_reservation
        from public.wallet_credit_ledger as ledger
        where ledger.idempotency_key = 'withdrawal-reserve:' || v_row.id::text;
        if not found or v_reservation.player_id <> v_row.player_id
           or v_reservation.amount_credits <> -v_row.amount_credits then
            raise exception 'Legacy withdrawal balance reservation is missing or inconsistent.'
                using errcode = '22023';
        end if;
    else
        if v_balance < v_row.amount_credits then
            raise exception 'Insufficient credits to settle the confirmed withdrawal.'
                using errcode = '22023';
        end if;
        v_new_balance := v_balance - v_row.amount_credits;
        insert into public.wallet_credit_ledger (
            player_id, entry_type, amount_credits, balance_after_credits,
            idempotency_key, memo
        )
        values (
            v_row.player_id, 'withdrawal', -v_row.amount_credits,
            v_new_balance, 'withdrawal-confirmed:' || v_row.id::text,
            'Confirmed CYFUR withdrawal ' || v_row.id::text
        );
        update public.wallet_credit_accounts
        set balance_credits = v_new_balance, updated_at = now()
        where player_id = v_row.player_id;
        v_balance := v_new_balance;
    end if;

    update public.wallet_withdrawals
    set status = 'confirmed',
        balance_deducted = true,
        confirmed_at = now(),
        updated_at = now()
    where id = p_withdrawal_id;

    return query select v_balance, false;
end;
$$;

create or replace function public.release_wallet_withdrawal(
    p_withdrawal_id uuid,
    p_failure_reason text,
    p_chain_failure_verified boolean default false,
    p_transaction_signature text default null
)
returns table (balance_credits bigint, already_released boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.wallet_withdrawals%rowtype;
    v_balance bigint;
    v_new_balance bigint;
    v_reservation public.wallet_credit_ledger%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_withdrawal_id is null or p_failure_reason is null
       or char_length(p_failure_reason) not between 1 and 500 then
        raise exception 'Invalid withdrawal release.' using errcode = '22023';
    end if;

    select * into v_row
    from public.wallet_withdrawals
    where id = p_withdrawal_id
    for update;
    if not found then
        raise exception 'Withdrawal reservation was not found.' using errcode = 'P0002';
    end if;
    if v_row.status = 'failed' then
        select account.balance_credits into v_balance
        from public.wallet_credit_accounts as account
        where account.player_id = v_row.player_id;
        return query select v_balance, true;
        return;
    end if;
    if v_row.status = 'pending' then
        if v_row.transaction_signature is not null then
            raise exception 'A withdrawal with a transaction signature cannot be released without chain verification.'
                using errcode = '22023';
        end if;
    elsif v_row.status = 'submitted' then
        if p_chain_failure_verified is distinct from true
           or v_row.transaction_signature is distinct from p_transaction_signature then
            raise exception 'Submitted withdrawal funds can only be released after verifying the transaction failed.'
                using errcode = '22023';
        end if;
    else
        raise exception 'This withdrawal reservation cannot be released.' using errcode = '22023';
    end if;

    select account.balance_credits into v_balance
    from public.wallet_credit_accounts as account
    where account.player_id = v_row.player_id
    for update;
    if v_row.balance_deducted then
        select * into v_reservation
        from public.wallet_credit_ledger as ledger
        where ledger.idempotency_key = 'withdrawal-reserve:' || v_row.id::text;
        if not found or v_reservation.player_id <> v_row.player_id
           or v_reservation.amount_credits <> -v_row.amount_credits then
            raise exception 'Legacy withdrawal balance reservation is missing or inconsistent.'
                using errcode = '22023';
        end if;
        if v_balance > 9223372036854775807 - v_row.amount_credits then
            raise exception 'Released balance exceeds the supported range.' using errcode = '22003';
        end if;
        v_new_balance := v_balance + v_row.amount_credits;
        insert into public.wallet_credit_ledger (
            player_id, entry_type, amount_credits, balance_after_credits,
            idempotency_key, memo
        )
        values (
            v_row.player_id, 'withdrawal_release', v_row.amount_credits,
            v_new_balance, 'withdrawal-release:' || v_row.id::text,
            'Release of withdrawal ' || v_row.id::text
        );
        update public.wallet_credit_accounts
        set balance_credits = v_new_balance, updated_at = now()
        where player_id = v_row.player_id;
        v_balance := v_new_balance;
    end if;

    update public.wallet_withdrawals
    set status = 'failed',
        balance_deducted = false,
        failure_reason = left(p_failure_reason, 500),
        updated_at = now()
    where id = p_withdrawal_id;

    return query select v_balance, false;
end;
$$;

revoke all on function public.reserve_wallet_withdrawal(uuid, text, text, text, text, text, bigint, integer, bigint, text, text)
    from public, anon, authenticated;
revoke all on function public.confirm_wallet_withdrawal(uuid, text)
    from public, anon, authenticated;
revoke all on function public.release_wallet_withdrawal(uuid, text, boolean, text)
    from public, anon, authenticated;
grant execute on function public.reserve_wallet_withdrawal(uuid, text, text, text, text, text, bigint, integer, bigint, text, text)
    to service_role;
grant execute on function public.confirm_wallet_withdrawal(uuid, text)
    to service_role;
grant execute on function public.release_wallet_withdrawal(uuid, text, boolean, text)
    to service_role;

do $$
begin
    if to_regprocedure('public.start_game_point_level(uuid,integer,uuid)') is not null then
        revoke execute on function public.start_game_point_level(uuid, integer, uuid)
            from public, anon, authenticated, service_role;
    end if;
    if to_regprocedure('public.start_game_point_level_timer(uuid,uuid)') is not null then
        revoke execute on function public.start_game_point_level_timer(uuid, uuid)
            from public, anon, authenticated, service_role;
    end if;
    if to_regprocedure('public.complete_game_point_level(uuid,uuid,integer,bigint,bigint)') is not null then
        revoke execute on function public.complete_game_point_level(uuid, uuid, integer, bigint, bigint)
            from public, anon, authenticated, service_role;
    end if;
    if to_regprocedure('public.claim_verified_game_points(uuid,text,text,bigint)') is not null then
        revoke execute on function public.claim_verified_game_points(uuid, text, text, bigint)
            from public, anon, authenticated, service_role;
    end if;
    if to_regprocedure('public.credit_verified_cyfur_game_points(uuid,text,text,bigint,numeric,integer,text,text,text)') is not null then
        revoke execute on function public.credit_verified_cyfur_game_points(
            uuid, text, text, bigint, numeric, integer, text, text, text
        ) from public, anon, authenticated, service_role;
    end if;
end;
$$;

revoke insert, update, delete on public.game_point_accounts,
    public.game_point_ledger, public.game_point_transaction_claims,
    public.game_point_level_sessions, public.game_point_level_completions,
    public.game_point_level_reward_claims
    from service_role;
grant select on public.game_point_accounts, public.game_point_ledger,
    public.game_point_transaction_claims, public.game_point_level_sessions,
    public.game_point_level_completions, public.game_point_level_reward_claims
    to service_role;

notify pgrst, 'reload schema';
commit;
