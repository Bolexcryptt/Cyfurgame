-- Apply after supabase-walletless-deposits.sql.
-- Apply only after the production deposit flow and finalized verifier have been tested.
-- Paid gameplay remains disabled.

update public.wallet_system_config
set treasury_address = '6KTSpvxGR2xvje3BG42QvmFjg2XLnFneCCSyVXhSKvys',
    deposits_enabled = true,
    paid_gameplay_enabled = false,
    updated_at = now()
where id = 1;
