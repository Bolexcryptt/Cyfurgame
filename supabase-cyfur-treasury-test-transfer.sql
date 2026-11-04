-- One-time audit and idempotency record for the owner-authorized CYFUR test transfer.
-- This does not modify player balances, wallets, gameplay, or normal withdrawals.

create table if not exists public.cyfur_treasury_test_transfers (
    transfer_id text primary key
        check (transfer_id = 'cyfur-mainnet-one-cyfur-v1'),
    idempotency_key uuid not null unique,
    network text not null check (network = 'mainnet-beta'),
    mint_address text not null
        check (mint_address = '9F4hLLngEAhepsH2HLTH6kBYmmq6dzm4GXRrcpME3uam'),
    token_program_id text not null
        check (token_program_id = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    treasury_address text not null
        check (treasury_address = '6KTSpvxGR2xvje3BG42QvmFjg2XLnFneCCSyVXhSKvys'),
    recipient text not null
        check (recipient = '4bSjz5zdgReegh9TwCgiPWn7BH1nUhfY3s1DwZdK3UT1'),
    amount_raw bigint not null check (amount_raw = 100000000),
    recipient_token_account text not null,
    recipient_account_existed boolean not null,
    recipient_balance_before_raw numeric(30, 0) not null check (recipient_balance_before_raw >= 0),
    treasury_sol_lamports bigint not null check (treasury_sol_lamports >= 0),
    treasury_token_balance_raw numeric(30, 0) not null check (treasury_token_balance_raw >= 100000000),
    required_rent_lamports bigint not null check (required_rent_lamports >= 0),
    fee_lamports bigint not null check (fee_lamports >= 0),
    status text not null check (status in (
        'reserved',
        'submitted',
        'confirmed',
        'failed',
        'finalized_unverified'
    )),
    transaction_signature text,
    recipient_balance_raw numeric(30, 0) check (recipient_balance_raw is null or recipient_balance_raw >= 0),
    created_at timestamptz not null default now(),
    confirmed_at timestamptz,
    check (
        (status = 'reserved' and transaction_signature is null)
        or (status <> 'reserved' and transaction_signature is not null)
    ),
    check (
        status <> 'confirmed'
        or recipient_balance_raw = recipient_balance_before_raw + 100000000
    )
);

alter table public.cyfur_treasury_test_transfers enable row level security;
revoke all on public.cyfur_treasury_test_transfers from public, anon, authenticated;
revoke all on public.cyfur_treasury_test_transfers from service_role;
grant select, insert, update on public.cyfur_treasury_test_transfers to service_role;

notify pgrst, 'reload schema';
