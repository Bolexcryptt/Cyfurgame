create table if not exists public.wallet_system_config (
    id smallint primary key check (id = 1),
    deposits_enabled boolean not null default false check (deposits_enabled = false),
    network text not null default 'mainnet-beta',
    official_mint_address text,
    token_program_id text,
    token_decimals integer check (token_decimals between 0 and 18),
    credits_per_token bigint not null default 10000 check (credits_per_token = 10000),
    rounding_policy text check (rounding_policy in ('floor', 'nearest', 'reject_fraction')),
    updated_at timestamptz not null default now(),
    check (
        official_mint_address is null
        or (token_program_id is not null and token_decimals is not null)
    )
);

insert into public.wallet_system_config (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.player_deposit_addresses (
    player_id uuid primary key references public.player_profiles (id) on delete cascade,
    deposit_address text not null unique,
    custody_provider text not null,
    provider_reference text not null unique,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    disabled_at timestamptz
);

create table if not exists public.wallet_credit_accounts (
    player_id uuid primary key references public.player_profiles (id) on delete cascade,
    balance_credits bigint not null default 0 check (balance_credits >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.wallet_deposits (
    id uuid primary key default gen_random_uuid(),
    player_id uuid not null references public.player_profiles (id) on delete cascade,
    network text not null check (network in ('mainnet-beta', 'devnet')),
    transaction_signature text not null,
    mint_address text not null,
    token_program_id text not null,
    deposit_address text not null,
    amount_raw numeric(78, 0) not null check (amount_raw > 0),
    token_decimals integer not null check (token_decimals between 0 and 18),
    finalized_slot bigint,
    status text not null default 'pending' check (status in ('pending', 'confirmed', 'failed')),
    failure_reason text,
    credit_amount_credits bigint check (credit_amount_credits >= 0),
    created_at timestamptz not null default now(),
    confirmed_at timestamptz,
    credited_at timestamptz,
    unique (network, transaction_signature),
    check (status <> 'confirmed' or (finalized_slot is not null and confirmed_at is not null)),
    check (credited_at is null or (status = 'confirmed' and credit_amount_credits is not null))
);

create index if not exists wallet_deposits_player_history_idx
    on public.wallet_deposits (player_id, created_at desc);

create index if not exists wallet_deposits_status_idx
    on public.wallet_deposits (status, created_at)
    where status = 'pending';

create table if not exists public.wallet_credit_ledger (
    id uuid primary key default gen_random_uuid(),
    player_id uuid not null references public.player_profiles (id) on delete cascade,
    deposit_id uuid references public.wallet_deposits (id) on delete restrict,
    entry_type text not null check (entry_type in ('deposit', 'game_entry', 'game_refund', 'adjustment')),
    amount_credits bigint not null check (amount_credits <> 0),
    balance_after_credits bigint not null check (balance_after_credits >= 0),
    idempotency_key text not null unique,
    memo text not null default '',
    created_at timestamptz not null default now(),
    check ((entry_type = 'deposit') = (deposit_id is not null)),
    unique (deposit_id)
);

create index if not exists wallet_credit_ledger_player_history_idx
    on public.wallet_credit_ledger (player_id, created_at desc);

create or replace function public.create_wallet_credit_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.wallet_credit_accounts (player_id)
    values (new.id)
    on conflict (player_id) do nothing;
    return new;
end;
$$;

revoke all on function public.create_wallet_credit_account() from public, anon, authenticated;

drop trigger if exists on_fluxgrid_profile_created_wallet_account on public.player_profiles;
create trigger on_fluxgrid_profile_created_wallet_account
    after insert on public.player_profiles
    for each row execute function public.create_wallet_credit_account();

insert into public.wallet_credit_accounts (player_id)
select id from public.player_profiles
on conflict (player_id) do nothing;

alter table public.wallet_system_config enable row level security;
alter table public.player_deposit_addresses enable row level security;
alter table public.wallet_credit_accounts enable row level security;
alter table public.wallet_deposits enable row level security;
alter table public.wallet_credit_ledger enable row level security;

revoke all on public.wallet_system_config from public, anon, authenticated;
revoke all on public.player_deposit_addresses from public, anon, authenticated;
revoke all on public.wallet_credit_accounts from public, anon, authenticated;
revoke all on public.wallet_deposits from public, anon, authenticated;
revoke all on public.wallet_credit_ledger from public, anon, authenticated;

grant select on public.player_deposit_addresses to authenticated;
grant select on public.wallet_credit_accounts to authenticated;
grant select on public.wallet_deposits to authenticated;
grant select on public.wallet_credit_ledger to authenticated;
grant select, update on public.wallet_system_config to service_role;
grant select, insert, update on public.player_deposit_addresses to service_role;
grant select on public.wallet_credit_accounts to service_role;
grant select, insert, update on public.wallet_deposits to service_role;
grant select on public.wallet_credit_ledger to service_role;

drop policy if exists "Players can view their own deposit address"
    on public.player_deposit_addresses;
create policy "Players can view their own deposit address"
    on public.player_deposit_addresses for select to authenticated
    using (player_id = (select auth.uid()));

drop policy if exists "Players can view their own credit balance"
    on public.wallet_credit_accounts;
create policy "Players can view their own credit balance"
    on public.wallet_credit_accounts for select to authenticated
    using (player_id = (select auth.uid()));

drop policy if exists "Players can view their own deposits"
    on public.wallet_deposits;
create policy "Players can view their own deposits"
    on public.wallet_deposits for select to authenticated
    using (player_id = (select auth.uid()));

drop policy if exists "Players can view their own credit ledger"
    on public.wallet_credit_ledger;
create policy "Players can view their own credit ledger"
    on public.wallet_credit_ledger for select to authenticated
    using (player_id = (select auth.uid()));

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
       or p_entry_type not in ('deposit', 'game_entry', 'game_refund', 'adjustment')
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
