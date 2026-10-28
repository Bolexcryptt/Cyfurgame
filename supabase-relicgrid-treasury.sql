-- Apply after supabase-walletless-deposits.sql.
-- Mirror the approved backend treasury constant into Supabase. Deposits stay disabled
-- until the finalized treasury token account and production configuration pass review.

update public.wallet_system_config
set treasury_address = '6KTSpvxGR2xvje3BG42QvmFjg2XLnFneCCSyVXhSKvys',
    deposits_enabled = false,
    paid_gameplay_enabled = false,
    updated_at = now()
where id = 1;
