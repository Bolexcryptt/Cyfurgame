# FluxGrid wallet integration

## Current design and safety

FluxGrid uses direct, non-custodial Solana deposits rather than CDP-managed per-player addresses. A player links a wallet by signing a short-lived server challenge, sends CYFUR from that wallet to the owner-controlled treasury, and submits the transaction signature. FluxGrid does not request, store, or use player private keys.

The server verifies the linked sender, treasury recipient, configured CYFUR mint and token program, successful finalized transaction, and actual token balance delta. The service-only Supabase RPC rechecks the linked wallet and treasury configuration, records the transaction signature uniquely, and applies the credit ledger entry atomically. Repeated submissions return the existing result rather than awarding credits again.

**Deposits and paid gameplay remain disabled.** The new migration explicitly sets both database switches false. Do not enable any deposit or paid-gameplay flags until the owner confirms the treasury, the deployed configuration matches Supabase, the new migration is applied, and devnet plus production-readiness checks pass. No real transfer or live Supabase write has been verified in this workspace.

The campaign remains before the wallet panel on the home page. Wallet linking uses Phantom's `connect` and `signMessage`; signing proves account ownership and does not send a transaction or pay a fee. On mobile, if the page is not already open in Phantom, the wallet panel offers Phantom's official browse deeplink to reopen the current HTTPS page in Phantom's in-app browser; the player then taps connect there. On desktop, the page requires Phantom's injected browser extension and must be opened in a normal browser tab where that extension has site access (embedded previews do not expose it). When the backend reports deposits READY, the player enters a CYFUR amount and approves an SPL `transferChecked` transaction in Phantom. FluxGrid submits its signature to the same server verifier and displays credits only after the verifier and atomic ledger RPC confirm the finalized transfer. The player pays the Solana network fee. A manual signature submission remains available for recovery. A transfer from any other wallet, to any other destination, using another mint, or not yet finalized receives no credit.

## Required setup

Apply these SQL files in order in the Supabase SQL Editor if not already applied:

1. `supabase-leaderboard.sql`
2. `supabase-wallet.sql`
3. `supabase-wallet-deposit-processing.sql`
4. `supabase-direct-treasury-deposits.sql`

The final migration adds the owner treasury address to `wallet_system_config`, linked-wallet/challenge tables, and service-only RPCs. It leaves `deposits_enabled` and `paid_gameplay_enabled` false. Set `wallet_system_config.treasury_address` to the owner's **public** Solana wallet address only after owner confirmation. Do not paste secrets into chat.

Configure these Vercel **server-side** variables:

- `SUPABASE_URL` — the existing Supabase project URL.
- `SUPABASE_PUBLISHABLE_KEY` — the Supabase publishable key used with the player's bearer token and RLS.
- `SUPABASE_SERVICE_ROLE_KEY` — secret service-role key, used only by API routes for trusted reads and RPCs.
- `SOLANA_RPC_URL` — trusted HTTPS Solana RPC endpoint.
- `SOLANA_NETWORK` — `devnet` for isolated testing; `mainnet-beta` only for production review.
- `SOLANA_TREASURY_ADDRESS` — the owner's public Solana wallet address; it must exactly match `wallet_system_config.treasury_address`.
- `WALLET_DIRECT_TREASURY_READY=true` — owner/operator acknowledgment that the treasury address, ownership, monitoring, and reconciliation process are reviewed. Leave unset until confirmed.
- `WALLET_DEPOSITS_ENABLED=true` — global deposit verification switch; leave unset until all tests and reviews pass.
- `WALLET_MAINNET_DEPOSITS_ENABLED=true` — additional production-only switch; leave unset unless the mainnet launch is explicitly approved.

Never set a variable beginning with `NEXT_PUBLIC_` for these values. Do not configure CDP keys or treasury signing keys; this flow does not need them. The owner receives transfers directly in the owner's treasury wallet, so no in-game custody service or automated sweep is involved.

Paid gameplay remains a separate feature gate: both `WALLET_PAID_GAMEPLAY_ENABLED=true` and `wallet_system_config.paid_gameplay_enabled=true` are required by the server, and both remain off until payment and game-economy testing is complete.

## Wallet link and deposit flow

`POST /api/wallet-link` supports two authenticated actions:

- `challenge` stores a random, five-minute challenge for the player and requested public wallet.
- `verify` validates its Ed25519 signature and atomically consumes the challenge through `link_player_solana_wallet`. A public key already linked to another player is rejected.

`POST /api/deposits` requires a linked wallet and the server/database gates. It independently queries the configured Solana RPC at finalized commitment, verifies the RPC's genesis hash, mint account/program/decimals, transfer instruction, treasury token-account delta, and source wallet authority. A failed, pending, mismatched, or uncreditable transfer is not credited.

The credit formula remains **1 CYFUR = 10,000 credits**. Each individual transfer uses integer floor rounding:

`credits = floor(raw_token_amount × 10,000 ÷ 10^token_decimals)`

Fractional-credit remainders are discarded per transaction; they do not carry across deposits. Transfers that convert to zero credits are rejected. With an 8-decimal mint, 10,000 raw units (0.0001 CYFUR) equal 1 credit.

## Test and launch checklist

1. Apply the migrations and verify the functions, table permissions, and RLS policies in Supabase.
2. Confirm the official CYFUR mint with the owner; set the mint, legacy Token Program ID, decimals, network, and `credits_per_token = 10000` in `wallet_system_config`.
3. Use a devnet test mint and devnet treasury first. Link a test wallet, then test wrong sender, wrong destination, wrong mint, failed and unfinalized transactions, fractional rounding, duplicate signature retries, and verified balance persistence.
4. Confirm the transaction unique constraint and atomic ledger behavior using the deployed Supabase RPC. Do not use real player data for test resets.
5. Only after owner approval and a successful controlled test should production treasury/network configuration be prepared. Keep the mainnet and paid-gameplay flags off until a separate production review.

Automated local tests cover deterministic conversion, wallet-signature verification, source-wallet and destination checks, finality outcomes, feature gates, and SQL invariants. They do not apply SQL, validate Supabase RPC behavior, access Vercel configuration, or prove a real on-chain deposit. No real deposit or production deployment was performed as part of this change.

## Economy and gameplay

Existing economy rules are unchanged:

- Entry cost: `floor(100 × 1.08^(level − 1))`
- Three-star payout: `floor(entry cost × 1.6)`
- Two-star refund: `floor(entry cost × 0.4)`
- One-star completion or failure: `0`

When deliberately enabled, paid level entry and completion use server-side sessions and atomic ledger RPCs. Entry requires sufficient verified credits; the server starts the timer, validates the submitted puzzle solution, calculates stars from elapsed server time, and awards a first-clear reward once. Automated tests do not replace live Supabase and production verification.
