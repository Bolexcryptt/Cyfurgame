-- Apply after supabase-unified-player-balance.sql.
-- Older wallet installs also have a ledger function that rejects game_reward.

begin;

alter table public.wallet_credit_ledger
    drop constraint if exists wallet_credit_ledger_entry_type_check;

alter table public.wallet_credit_ledger
    add constraint wallet_credit_ledger_entry_type_check
    check (entry_type in (
        'deposit', 'game_entry', 'game_refund', 'game_reward', 'adjustment',
        'withdrawal_reserve', 'withdrawal_release', 'withdrawal'
    ));

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

commit;
