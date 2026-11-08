-- Apply after supabase-game-points.sql.
-- Existing balances and ledger entries are preserved. Historical link claims are
-- recorded for duplicate protection; their balances are not recalculated.

create table if not exists public.game_point_transaction_claims (
    transaction_signature text primary key,
    player_id uuid not null references public.player_profiles (id) on delete cascade,
    network text,
    finalized_slot bigint,
    claimed_at timestamptz not null default now()
);

alter table public.game_point_transaction_claims enable row level security;
revoke all on public.game_point_transaction_claims from public, anon, authenticated;
grant select, insert on public.game_point_transaction_claims to service_role;

insert into public.game_point_transaction_claims (
    transaction_signature,
    player_id
)
select substring(l.idempotency_key from 12), l.player_id
from public.game_point_ledger as l
where l.entry_type = 'link_claim'
  and l.idempotency_key like 'link-claim:%'
on conflict (transaction_signature) do nothing;

drop function if exists public.claim_game_points(uuid, text);

create or replace function public.claim_verified_game_points(
    p_player_id uuid,
    p_transaction_signature text,
    p_network text,
    p_finalized_slot bigint
)
returns table (balance_points bigint, already_claimed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_balance bigint;
    v_claimed_rows integer;
    v_ledger_rows integer;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Server authorization is required.' using errcode = '42501';
    end if;
    if p_player_id is null
       or p_transaction_signature is null
       or p_transaction_signature !~ '^[1-9A-HJ-NP-Za-km-z]{80,100}$'
       or p_network is null
       or p_network not in ('devnet', 'mainnet-beta')
       or p_finalized_slot is null
       or p_finalized_slot <= 0 then
        raise exception 'Invalid verified game-points claim.' using errcode = '22023';
    end if;

    perform 1 from public.player_profiles where id = p_player_id for update;
    if not found then
        raise exception 'Player profile was not found.' using errcode = 'P0002';
    end if;

    insert into public.game_point_accounts (player_id)
    values (p_player_id)
    on conflict (player_id) do nothing;
    perform 1 from public.game_point_accounts where player_id = p_player_id for update;

    insert into public.game_point_transaction_claims (
        transaction_signature, player_id, network, finalized_slot
    )
    values (
        p_transaction_signature, p_player_id, p_network, p_finalized_slot
    )
    on conflict (transaction_signature) do nothing;
    get diagnostics v_claimed_rows = row_count;

    if v_claimed_rows = 1 then
        insert into public.game_point_ledger (
            player_id, entry_type, amount_points, idempotency_key
        )
        values (
            p_player_id,
            'link_claim',
            1000,
            'link-claim:' || p_transaction_signature
        )
        on conflict (idempotency_key) do nothing;
        get diagnostics v_ledger_rows = row_count;
        if v_ledger_rows = 1 then
            update public.game_point_accounts
            set balance_points = balance_points + 1000,
                updated_at = now()
            where player_id = p_player_id
            returning balance_points into v_balance;
            return query select v_balance, false;
            return;
        end if;
    end if;

    select balance_points into v_balance
    from public.game_point_accounts
    where player_id = p_player_id;
    return query select v_balance, true;
end;
$$;

revoke all on function public.claim_verified_game_points(uuid, text, text, bigint)
    from public, anon, authenticated;
grant execute on function public.claim_verified_game_points(uuid, text, text, bigint)
    to service_role;

notify pgrst, 'reload schema';
