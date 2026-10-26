-- Apply after supabase-walletless-deposits.sql.
-- The treasury is an owner-supplied public wallet address. Deposits stay disabled
-- until its control, the production CYFUR configuration, and server variables pass review.

update public.wallet_system_config
set treasury_address = 'BQa1gxbBP2jNJEzyHHtMAUfJepXjTnqQEhBuojL9E3ts',
    deposits_enabled = false,
    paid_gameplay_enabled = false,
    updated_at = now()
where id = 1;
