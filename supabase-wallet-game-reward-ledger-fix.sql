-- Apply after supabase-unified-player-balance.sql.
-- The balance migration must allow the game_reward entries written by
-- complete_wallet_level. This updates only the ledger type constraint.

begin;

alter table public.wallet_credit_ledger
    drop constraint if exists wallet_credit_ledger_entry_type_check;

alter table public.wallet_credit_ledger
    add constraint wallet_credit_ledger_entry_type_check
    check (entry_type in (
        'deposit', 'game_entry', 'game_refund', 'game_reward', 'adjustment',
        'withdrawal_reserve', 'withdrawal_release', 'withdrawal'
    ));

commit;
