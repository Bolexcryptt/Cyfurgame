# RelicGrid wallet integration

## Current design and safety

RelicGrid uses direct, non-custodial Solana deposits to the configured owner-controlled treasury. Players do not connect or link a wallet to the game; they can send from any Solana wallet and submit the transaction signature as an untrusted lookup identifier. RelicGrid does not request, store, or use player private keys. The shared treasury address is not a unique player wallet: each authenticated deposit intent supplies a unique memo to identify the player and exact amount.

The server independently verifies the configured Solana network, exact CYFUR mint and token program, treasury token-account balance delta, exact amount, unique payment memo, successful finalized transaction, and a transaction signer. The service-only Supabase RPC rechecks the intent and treasury configuration, records the transaction signature uniquely, and applies the credit ledger entry atomically. Repeated submissions return the existing result rather than awarding credits again. The wallet used to send must support adding a transaction memo.

**Deposits and paid gameplay remain disabled.** The new migration explicitly sets both database switches false. Do not enable any deposit or paid-gameplay flags until the owner confirms the treasury, the deployed configuration matches Supabase, the new migration is applied, and devnet plus production-readiness checks pass. No real transfer or live Supabase write has been verified in this workspace.

The authenticated deposit flow creates a 15-minute server-side intent tied to the player, exact amount, network, mint, token program, and treasury. The game displays the treasury address, exact amount, and unique memo for the player to include in an external wallet transfer. The player then submits the transaction signature; this signature is only an RPC lookup key, never proof of payment. The migration is not applied and no real deposit has been tested; do not enable deposits until deployment, schema, and end-to-end checks are complete.

The approved treasury address has one code source of truth: `RELICGRID_TREASURY_ADDRESS` in `server/lib/solana-deposit.js`. Supabase `wallet_system_config.treasury_address` must mirror that address and is rejected if it differs. The browser displays the server-returned approved address; no separate Vercel treasury-address variable is used.

The campaign and leaderboard are unchanged. Depositing does not open Phantom or sign/broadcast a transaction from the game. After the player sends the transfer externally, the server checks it at finalized commitment and credits only after the verifier and atomic ledger RPC confirm it. A missing or not-yet-finalized transaction can be retried with the same signature; duplicate credit is prevented. A failed transfer, wrong destination, wrong mint, wrong amount, missing memo, expired intent, or unfinalized transfer receives no credit.

## Required setup

Apply these SQL files in order in the Supabase SQL Editor if not already applied:

1. `supabase-leaderboard.sql`
2. `supabase-wallet.sql`
3. `supabase-wallet-deposit-processing.sql`
4. `supabase-direct-treasury-deposits.sql`
5. `supabase-payment-intents.sql`
6. `supabase-walletless-deposits.sql`

The direct-treasury migration adds the approved treasury address and service-only RPCs. The wallet-link tables remain for compatibility but are not required for deposits. The wallet-less migration makes pending intents sender-independent while preserving finalized verification and atomic duplicate protection. The migrations leave `deposits_enabled` and `paid_gameplay_enabled` false. The Supabase treasury row must match the approved backend address. Do not paste secrets into chat.

Configure these Vercel **server-side** variables:

- `SUPABASE_URL` — the existing Supabase project URL.
- `SUPABASE_PUBLISHABLE_KEY` — the Supabase publishable key used with the player's bearer token and RLS.
- `SUPABASE_SERVICE_ROLE_KEY` — secret service-role key, used only by API routes for trusted reads and RPCs.
- `SOLANA_RPC_URL` — trusted HTTPS Solana RPC endpoint.
- `SOLANA_NETWORK` — `devnet` for isolated testing; `mainnet-beta` only for production review.
- `WALLET_DIRECT_TREASURY_READY=true` — owner/operator acknowledgment that the treasury address, ownership, monitoring, and reconciliation process are reviewed. Leave unset until confirmed.
- `WALLET_DEPOSITS_ENABLED=true` — global deposit verification switch; leave unset until all tests and reviews pass.
- `WALLET_MAINNET_DEPOSITS_ENABLED=true` — additional production-only switch; leave unset unless the mainnet launch is explicitly approved.
- `GAME_FRONTEND_ORIGIN` — exact HTTPS browser origin allowed to call the API cross-origin (for example, the GitHub Pages origin); never use a wildcard.
- `GAME_API_BASE_URL` — frontend build-time/public config in `supabase-config.js`, set to the deployed HTTPS API origin when the game and API use different origins. Leave empty only when `/api` is served from the same origin.

Never set a variable beginning with `NEXT_PUBLIC_` for these values. Do not configure CDP keys or treasury signing keys; this flow does not need them. The owner receives transfers directly in the owner's treasury wallet, so no in-game custody service or automated sweep is involved.

Free gameplay testing is currently enabled in the client: selecting an unlocked level does not call the paid-entry API, charge credits, or award wallet credits. Campaign progress is still saved through the existing local/leaderboard completion path. Paid gameplay remains server-gated: both `WALLET_PAID_GAMEPLAY_ENABLED=true` and `wallet_system_config.paid_gameplay_enabled=true` are required by the server, and both remain off until payment and game-economy testing is complete.

## Wallet-less deposit flow

`POST /api/payment-intent` requires an authenticated player and the server/database gates, but no wallet connection. It creates a 15-minute record with exact raw amount, network, mint, token program, and treasury address, and returns a unique Memo value. The UI shows that memo and amount alongside the configured treasury address; use a Solana wallet that supports transaction memos and include the memo exactly. `POST /api/deposits` needs only the submitted transaction signature or supported Explorer/Solscan link: the server extracts the intent ID from the finalized transaction memo, then looks up that intent for the authenticated player. It independently queries the configured Solana RPC at finalized commitment, verifies the RPC genesis hash, mint account/program/decimals, a signed transfer instruction, treasury token-account delta, exact intent memo, and minimum amount. A failed, pending, expired, mismatched, or uncreditable transfer is not credited. The service-only `process_verified_payment_intent` RPC rechecks and consumes the intent in the same database transaction as the existing idempotent treasury ledger credit. The expected treasury associated token account must exist before payment intents are enabled; creating that account requires a transaction payer to fund its rent and fee.

The old wallet-link and Phantom transaction endpoints remain for compatibility, but the player-facing deposit flow does not call them or require a linked wallet. The finalized verifier remains the only path that credits a deposit.

The credit formula remains **1 CYFUR = 10,000 credits**. Each individual transfer uses integer floor rounding:

`credits = floor(raw_token_amount × 10,000 ÷ 10^token_decimals)`

Fractional-credit remainders are discarded per transaction; they do not carry across deposits. Transfers that convert to zero credits are rejected. With an 8-decimal mint, 10,000 raw units (0.0001 CYFUR) equal 1 credit.

## Test and launch checklist

1. Apply the migrations and verify the functions, table permissions, and RLS policies in Supabase.
2. Confirm the official CYFUR mint with the owner; set the mint, legacy Token Program ID, decimals, network, and `credits_per_token = 10000` in `wallet_system_config`.
3. Use a devnet test mint and devnet treasury first. Send from an unlinked test wallet and test wrong destination, wrong mint, failed and unfinalized transactions, fractional rounding, missing/wrong memo, duplicate signature retries, and verified balance persistence.
4. Test server-issued payment intents bound to player, exact amount, mint, network, and treasury; test expiration, wrong memo/amount, failed transaction, and replay against a deployed Supabase/RPC setup before enabling deposits.
5. Confirm the transaction unique constraint and atomic ledger behavior using the deployed Supabase RPC. Do not use real player data for test resets.
6. Only after owner approval and a successful controlled test should production treasury/network configuration be prepared. Keep the mainnet and paid-gameplay flags off until a separate production review.

Automated local tests cover deterministic conversion, wallet-signature verification for the legacy wallet-link endpoint, signed-source and destination checks, finality outcomes, feature gates, and SQL invariants. They do not apply SQL, validate Supabase RPC behavior, access Vercel configuration, or prove a real on-chain deposit. No real deposit or production deployment was performed as part of this change.

## Economy and gameplay

Existing economy rules are unchanged:

- Entry cost: `floor(100 × 1.08^(level − 1))`
- Three-star payout: `floor(entry cost × 1.6)`
- Two-star refund: `floor(entry cost × 0.4)`
- One-star completion or failure: `0`

When deliberately enabled, paid level entry and completion use server-side sessions and atomic ledger RPCs. Entry requires sufficient verified credits; the server starts the timer, validates the submitted puzzle solution, calculates stars from elapsed server time, and awards a first-clear reward once. Automated tests do not replace live Supabase and production verification.
