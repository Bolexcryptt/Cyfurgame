-- Apply after supabase-shared-treasury-deposit-attribution.sql.
-- This read-only check never enables deposits or changes player data.

create or replace function public.relicgrid_deposit_schema_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(auth.role(), '') = 'service_role'
       and to_regclass('public.wallet_system_config') is not null
       and to_regclass('public.wallet_payment_intents') is not null
       and to_regclass('public.wallet_deposits') is not null
       and to_regclass('public.wallet_credit_accounts') is not null
       and to_regclass('public.wallet_credit_ledger') is not null
       and to_regprocedure(
           'public.process_verified_payment_intent(uuid,uuid,text,text,text,text,text,text,numeric,integer,bigint,timestamptz,bigint)'
       ) is not null
       and to_regprocedure(
           'public.process_verified_treasury_deposit(uuid,text,text,text,text,text,text,numeric,integer,bigint,bigint)'
       ) is not null
       and to_regprocedure(
           'public.apply_wallet_ledger_entry(uuid,text,bigint,text,uuid,text)'
       ) is not null
       and pg_catalog.has_function_privilege(
           'service_role',
           'public.process_verified_payment_intent(uuid,uuid,text,text,text,text,text,text,numeric,integer,bigint,timestamptz,bigint)',
           'EXECUTE'
       )
       and pg_catalog.has_function_privilege(
           'service_role',
           'public.process_verified_treasury_deposit(uuid,text,text,text,text,text,text,numeric,integer,bigint,bigint)',
           'EXECUTE'
       )
       and pg_catalog.has_function_privilege(
           'service_role',
           'public.apply_wallet_ledger_entry(uuid,text,bigint,text,uuid,text)',
           'EXECUTE'
       )
       and exists (
           select 1
           from pg_catalog.pg_index as indexes
           where indexes.indrelid = pg_catalog.to_regclass('public.wallet_payment_intents')
             and indexes.indisunique
             and indexes.indisvalid
             and pg_catalog.pg_get_indexdef(indexes.indexrelid)
                 ~* '\(network, transaction_signature\)'
       )
       and exists (
           select 1
           from pg_catalog.pg_index as indexes
           where indexes.indrelid = pg_catalog.to_regclass('public.wallet_deposits')
             and indexes.indisunique
             and indexes.indisvalid
             and pg_catalog.pg_get_indexdef(indexes.indexrelid)
                 ~* '\(network, transaction_signature\)'
       )
       and exists (
           select 1
           from pg_catalog.pg_index as indexes
           where indexes.indrelid = pg_catalog.to_regclass('public.wallet_credit_ledger')
             and indexes.indisunique
             and indexes.indisvalid
             and pg_catalog.pg_get_indexdef(indexes.indexrelid)
                 ~* '\(idempotency_key\)'
       );
$$;

revoke all on function public.relicgrid_deposit_schema_ready()
    from public, anon, authenticated;
grant execute on function public.relicgrid_deposit_schema_ready()
    to service_role;
