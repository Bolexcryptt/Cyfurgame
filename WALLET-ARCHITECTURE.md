# RelicGrid wallet integration

## Current design and safety

RelicGrid uses direct, non-custodial Solana deposits to the configured owner-controlled treasury. Players do not connect or link a wallet for deposits; they can send from any Solana wallet and submit the transaction signature as an untrusted lookup identifier. Withdrawals use a separately linked and ownership-verified receiving wallet. RelicGrid does not request, store, or use player private keys. The shared treasury address is not a unique player wallet: each authenticated deposit intent supplies a unique memo to identify the player and exact amount.

## Player authentication and account recovery

The browser restores a persisted Supabase session and verifies it with Supabase Auth before loading player data. It creates an anonymous Auth user only when no session exists; it never authenticates from a callsign or a `localStorage` player ID. `auth.users.id` is the permanent player identity: `player_profiles.id` references it, and progress, credit accounts, ledger entries, deposits, linked wallets, and withdrawals reference that profile ID. Linking a recovery email verifies ownership on the current session and preserves the same user ID, so no player rows or balances are migrated.

On a new device, a player can request an email OTP for an existing account. The flow disables user creation and the server allows switching from the new anonymous identity only after a read-only check confirms that identity has no saved player data. It fails closed if records cannot be checked or any player data exists. The recovery OTP signs into the original Supabase user; the game then discards local cached progress and reloads the server profile and progress under that Auth user ID. Never merge balances by callsign, email text, or a client-supplied ID.

Enable anonymous sign-ins, manual identity linking, and the Supabase email provider for the project. Configure the email templates to include the six-digit OTP used by the game. For a future Android or iOS client, use the same Supabase project and Auth user IDs, persist sessions with the platform's secure storage adapter, and send the Supabase access token as the API bearer token. Solana wallet ownership remains a separate proof: the user signs a server-issued message, and the game stores only the verified public address. No seed phrase or private key is requested.

The server independently verifies the configured Solana network, exact CYFUR mint and token program, treasury token-account balance delta, exact amount, unique payment memo, successful finalized transaction, and a transaction signer. After the active account-bound intent passes verification, the API waits five seconds before calling the service-only Supabase RPC, which rechecks the intent and treasury configuration, records the transaction signature uniquely, and applies the credit ledger entry atomically. Repeated submissions return the existing result rather than awarding credits again. The wallet used to send must support adding a transaction memo.

**Deposits and paid gameplay remain disabled by default.** Do not enable any deposit or paid-gameplay flags until the owner confirms the treasury, the deployed configuration matches Supabase, the migrations are applied, and devnet plus production-readiness checks pass. No real transfer or live Supabase write has been verified in this workspace.

The authenticated deposit flow creates a 15-minute server-side intent tied to the player, minimum amount, network, mint, token program, and treasury. The game displays the treasury address, amount, and unique memo for the player to include in an external wallet transfer. The player then submits the transaction signature or supported explorer link; it is only an RPC lookup key, never proof of payment. The shared-treasury attribution migration was updated to remove an unintended linked-wallet requirement; apply the updated SQL before using this flow. No real deposit has been tested in this workspace.

The configured treasury address has one code source of truth: `RELICGRID_TREASURY_ADDRESS` in `server/lib/solana-deposit.js` (`6KTSpvxGR2xvje3BG42QvmFjg2XLnFneCCSyVXhSKvys`). Supabase `wallet_system_config.treasury_address` must mirror that address and is rejected if it differs. The browser displays the server-returned address; no separate Vercel treasury-address variable is used. This code value is not independent proof of treasury ownership or owner approval.

The campaign and leaderboard are unchanged. Depositing does not open Phantom or sign/broadcast a transaction from the game. After the player sends the transfer externally, the server checks it at finalized commitment and credits only after the verifier and atomic ledger RPC confirm it. A missing or not-yet-finalized transaction can be retried with the same signature; duplicate credit is prevented. A failed transfer, wrong destination, wrong mint, wrong amount, missing memo, expired intent, or unfinalized transfer receives no credit.

## One-time treasury test transfer

`POST /api/treasury-test-transfer` is a separate, owner-only operation for the single approved mainnet test: exactly 100,000,000 raw CYFUR units (1 CYFUR) from the fixed treasury to `4bSjz5zdgReegh9TwCgiPWn7BH1nUhfY3s1DwZdK3UT1`. It does not read or alter player balances, credits, ledger rows, or normal withdrawal records. The API requires a 32-byte random base64url `CYFUR_TEST_TRANSFER_OWNER_TOKEN`, `CYFUR_TEST_TRANSFER_ENABLED=true`, explicit `SOLANA_NETWORK=mainnet-beta` and `SOLANA_RPC_URL`, the existing server-side treasury signing key, the Supabase service-role configuration, and `VERCEL_ENV=production`. The route stays disabled unless the owner token and enable flag are configured. Never put the owner token or signing key in browser code.

The request must use the exact approved recipient and amount, include the confirmation phrase `SEND EXACTLY 1 CYFUR TO APPROVED TEST WALLET`, and supply a UUID idempotency key. A durable, globally unique Supabase record reserves this specific transfer before signing. It is never cleared or retried automatically: any existing record blocks another send, including requests with a different idempotency key. Before signing, the API verifies mainnet genesis, finalized mint and treasury token account, the exact recipient ATA, treasury SOL/CYFUR funds, current ATA rent, and estimated transaction fee. It records the signature before broadcast, waits for finalized confirmation, and verifies the recipient balance increased by exactly 100,000,000 raw units. An ambiguous result remains reserved for manual reconciliation; it must not be retried.

Apply `supabase-cyfur-treasury-test-transfer.sql` to the same Supabase project used by the API before enabling the route. Configure the owner token and `CYFUR_TEST_TRANSFER_ENABLED` only for the short, owner-approved test window. The route is not invoked during deployment and this repository does not submit a mainnet transfer.

`GET /api/treasury-test-transfer` is a read-only check on the dedicated test-transfer route. It requires the same owner token but does not reserve the one-time transfer, sign, create accounts, or submit transactions. It verifies the configured gates, signer address, Supabase service-role access and existing reservation, then reads finalized mainnet balances, mint, recipient ATA, current rent, and estimated fee. It reports `readyToExecute` only when every required gate passes and no one-time record exists. `POST` remains the separate owner-authorized transfer operation and retains its fixed recipient, amount, and idempotency safeguards.

## Campaign access

All 99 levels can be selected in any order. Free practice is available even when authentication, wallet APIs, paid gameplay, or entry credits are unavailable; practice does not charge credits or save leaderboard progress/rewards. When paid gameplay is enabled and a player has enough verified credits, the server may still authorize a paid entry and record its verified completion. The obsolete `LEVELS_LOCKED` environment variable is ignored so a stale deployment setting cannot lock the game.

Game access points use a separate server-managed account and ledger. A syntactically valid Solscan transaction signature is only used as a one-time claim identifier; this flow does not verify a Solana payment. A successful claim adds 1,000 non-withdrawable game points. Starting a campaign level atomically deducts `floor(100 × 1.08^(level - 1))` points, and the server credits the completion reward according to the server-rated star count: 160% for three stars, 40% for two stars, and zero for one star or a failed level. Unique signature, entry-request, session, and player-level keys prevent duplicate claims, charges, and rewards. These point accounts and completions never write wallet credit, CYFUR token, leaderboard, or withdrawal-gate records. Apply `supabase-game-points.sql` before deploying this flow; until then the points API fails closed.

## Required setup

Apply these SQL files in order in the Supabase SQL Editor if not already applied:

1. `supabase-leaderboard.sql`
2. `supabase-wallet.sql`
3. `supabase-wallet-deposit-processing.sql`
4. `supabase-direct-treasury-deposits.sql`
5. `supabase-payment-intents.sql`
6. `supabase-walletless-deposits.sql`
7. `supabase-shared-treasury-deposit-attribution.sql`
8. `supabase-deposit-readiness.sql`
9. `supabase-relicgrid-treasury.sql` (only after the required production review and owner approval)
10. `supabase-wallet-withdrawals.sql`
11. `supabase-wallet-level-entry-safety.sql`
12. `supabase-wallet-all-levels-access.sql`
13. `supabase-cyfur-treasury-test-transfer.sql` (only when preparing the separate, owner-authorized one-time test)
14. `supabase-game-points.sql`

The direct-treasury migration adds the treasury address and service-only RPCs. The wallet-link tables remain for compatibility but are not required for deposits. The wallet-less migration makes pending intents sender-independent while preserving finalized verification and atomic duplicate protection. The shared-treasury attribution migration stores the verified on-chain sender but credits the account identified by its unique payment-intent memo; it does not require the player to link that wallet. Re-run it after updating this function if an earlier version of the migration enforced linked-wallet ownership. The read-only deposit-readiness migration checks that the required tables, RPCs, service-role permissions, unique transaction constraints, and ledger idempotency constraint exist; missing schema or access fails closed. It does not enable deposits or change player data. The treasury migration updates `wallet_system_config.treasury_address` to the code value and enables deposits while keeping paid gameplay disabled. Do not apply it until the owner approves enabling live deposits after all readiness checks and testing. The withdrawal migration adds `withdrawals_enabled=false`, a `withdrawal_rate_limit_per_hour=5` setting, and service-only reserve, submit, confirm, and release RPCs. It records negative reservation and positive release entries in the existing credit ledger; it does not change current balances, game scores, progress, or leaderboard rows during migration. A database insert trigger serializes and enforces the five-request rolling-hour limit. The current migration was applied to the production Supabase project and verified to have the limit set to five, the trigger active, and no pending/submitted records. Reapplying `supabase-wallet-withdrawals.sql` is idempotent; editing this file alone does not update a live database. Existing pending/submitted withdrawal rows must be reconciled before new withdrawals; never clear them manually to free a reservation.

The level-entry safety migration replaces only `start_wallet_level`. Under the existing per-player profile lock, it reuses an active session for the same level (including retries with a new request ID) without charging again, and rejects a different level while that session is active. The all-level access migration then removes only the completion-order restriction: it retains the active-session check, verified-balance check, and atomic entry debit. Neither migration changes existing balances, ledger rows, level progress, scores, or leaderboard data, enables paid gameplay, or changes treasury settings. Apply both after the wallet processing migration; code changes alone do not update a live Supabase function.

Configure these Vercel variables in the project that hosts the API:

- `SUPABASE_URL` — the existing Supabase project URL.
- `SUPABASE_PUBLISHABLE_KEY` — the Supabase publishable key used with the player's bearer token and RLS.
- `SUPABASE_SERVICE_ROLE_KEY` — secret service-role key, used only by API routes for trusted reads and RPCs.
- `SOLANA_NETWORK=mainnet-beta` and `WALLET_APPROVED_CYFUR_MINT_ADDRESS=9F4hLLngEAhepsH2HLTH6kBYmmq6dzm4GXRrcpME3uam` — explicit production network and owner-approved mint configuration.
- `WALLET_DIRECT_TREASURY_READY=true`, `WALLET_DEPOSITS_ENABLED=true`, and `WALLET_MAINNET_DEPOSITS_ENABLED=true` — all three server-side deposit gates must be explicitly true; missing or empty values are disabled. Keep them unset/false until the owner approves live deposits.
- `WITHDRAWAL_TREASURY_PRIVATE_KEY` — optional and only for withdrawals. Deposits never use a treasury private key. Do not configure this until withdrawals have separately passed server-signing and confirmation tests. Never use a client-prefixed variable, commit, log, or send this key to the browser.
- `WITHDRAWAL_ENABLED` — leave unset or `false` until the signer, owner-approved mint, live Supabase row, token account and funding, and a separately authorized small test are verified.
- `wallet_system_config.withdrawals_enabled` — remains false by default; only the owner/operator should enable it after the same review. Both this DB gate and `WITHDRAWAL_ENABLED=true` are required for an actual payout.
- `WITHDRAWAL_DIAGNOSTIC_SECRET` — optional strong server-only secret protecting `GET /api/withdrawal-diagnostics`; required to run that deployment-only diagnostic.

The withdrawal diagnostic reports whether `WITHDRAWAL_ENABLED` and `wallet_system_config.withdrawals_enabled` are both enabled. Its overall `ok` result requires both gates as well as the signer, Supabase RPC, RPC health, network, mint, and treasury token-account checks. Solana RPC diagnostics call `getHealth` and `getGenesisHash` before finalized mint and treasury-account reads. The response separately labels the Solana `rpc` check and `supabaseWithdrawalRpc` check, and reports the Vercel network value, Supabase network, and network detected from the RPC genesis hash. Failure reasons are categorized without returning RPC URLs, provider credentials, Supabase response bodies, or private-key values.

Set `SOLANA_RPC_URL` to the provider's HTTPS Solana JSON-RPC endpoint (POST-compatible), not a dashboard, REST, or WebSocket URL. The public mainnet endpoint `https://api.mainnet-beta.solana.com` is a valid fallback but may be rate-limited. Applying `supabase-wallet-withdrawals.sql` is idempotent for withdrawal schema objects and preserves existing `withdrawals_enabled` state; it requests a PostgREST schema reload at the end. The migration adds the service-only `reserve_wallet_withdrawal`, `mark_wallet_withdrawal_submitted`, `confirm_wallet_withdrawal`, and `release_wallet_withdrawal` RPCs without deleting player, balance, or ledger rows.

Deposit verification defaults in code to Solana mainnet, the supported CYFUR mint, and `https://api.mainnet-beta.solana.com`; the network and RPC URL can still be overridden for isolated testing or an operator-selected provider. The public RPC may be rate-limited or unavailable. Any RPC failure fails closed and cannot award credits. The wallet API reports READY only when server switches are explicitly true, the database deposit switch and exact treasury/mint/token configuration match, the readiness RPC confirms schema and privileges, and finalized Solana RPC checks validate the mainnet, mint, and treasury token account. Applying `supabase-relicgrid-treasury.sql` enables the database deposit switch; do this only after production checks and testing, with owner approval. Paid gameplay remains disabled.

The authenticated `GET /api/wallet` readiness response gives a user-facing reason when any required database or chain check fails. Vercel function logs record only non-secret readiness check IDs and the Solana network. RPC failures are logged separately with the operation and safe error code; RPC URLs, credentials, and private keys are never logged. Redeploy after changing API environment variables.
- `GAME_FRONTEND_ORIGIN` — exact HTTPS browser origin allowed to call the API cross-origin (for example, the GitHub Pages origin); never use a wildcard.
- `GAME_API_BASE_URL` — frontend build-time/public config in `supabase-config.js`, set to the deployed HTTPS API origin when the game and API use different origins. Leave empty only when `/api` is served from the same origin. This is a code setting, not a Vercel secret.

Never set a variable beginning with `NEXT_PUBLIC_` for private or server-only values. Deposits are player-signed transfers to the treasury and do not use the treasury private key. Withdrawals use that single key for server-side signing. No second treasury signer is needed by the current implementation.

All 99 levels can be selected in any order when the global campaign pause is off. Paid gameplay remains server-gated: both `WALLET_PAID_GAMEPLAY_ENABLED=true` and `wallet_system_config.paid_gameplay_enabled=true` are required by the server. Every paid entry still requires an active server-issued session and sufficient verified credits.

## Wallet-less deposit flow

`POST /api/payment-intent` requires an authenticated player and the server/database gates, but no wallet connection. It creates a 15-minute record with exact raw amount, network, mint, token program, and treasury address, and returns a unique Memo value. The UI shows that memo and amount alongside the configured treasury address; use a Solana wallet that supports transaction memos and include the memo exactly. `POST /api/deposits` needs only the submitted transaction signature or supported Explorer/Solscan link: the server extracts the intent ID from the finalized transaction memo, then looks up that intent for the authenticated player. It independently queries the configured Solana RPC at finalized commitment, verifies the RPC genesis hash, mint account/program/decimals, a signed transfer instruction, treasury token-account delta, exact intent memo, and minimum amount. A failed, pending, expired, mismatched, or uncreditable transfer is not credited. The service-only `process_verified_payment_intent` RPC rechecks and consumes the intent in the same database transaction as the existing idempotent treasury ledger credit. The expected treasury associated token account must exist before payment intents are enabled; creating that account requires a transaction payer to fund its rent and fee.

The old wallet-link and Phantom transaction endpoints remain for compatibility, but the player-facing deposit flow does not call them or require a linked wallet. The finalized verifier remains the only path that credits a deposit.

The credit formula remains **1 CYFUR = 10,000 credits**. Each individual transfer uses integer floor rounding:

`credits = floor(raw_token_amount × 10,000 ÷ 10^token_decimals)`

Fractional-credit remainders are discarded per transaction; they do not carry across deposits. Transfers that convert to zero credits are rejected. With an 8-decimal mint, 10,000 raw units (0.0001 CYFUR) equal 1 credit.

## Withdrawal accounting and recovery

The player interface uses only the authenticated, verified linked wallet; the destination is read-only. Players may request any positive whole-credit amount up to their available balance, at 10,000 credits per CYFUR with floor conversion and no invented minimum, subject to a five-request rolling-hour database-enforced limit. The API is mainnet-only. It first calls `reserve_wallet_withdrawal`, which locks the player's credit account, verifies the DB withdrawal switch and conversion, records the unique request, reserves the credits, and writes one `withdrawal_reserve` ledger entry atomically. A database trigger serializes all inserts for that player and enforces the rolling-hour limit. Only then is a treasury transfer signed. Before signing, the backend verifies finalized mint and treasury token accounts, checks/creates the recipient ATA, queries current ATA rent and message fees, and ensures the treasury has sufficient SOL and CYFUR. The locally derived transaction signature is recorded via `mark_wallet_withdrawal_submitted` before broadcast. After finalized confirmation, the backend verifies the recipient balance increased by exactly the requested amount and records the withdrawal with `confirm_wallet_withdrawal`; confirmation does not debit a second time. A pre-broadcast failure releases the reservation with `release_wallet_withdrawal`. A submitted transfer is released only after the backend has verified the transaction failed on-chain. Timeouts and uncertain submission keep the reservation and block another active withdrawal until reconciled. The same client request ID is reused on retries; confirmed or failed records cannot be replayed into another transfer.

The former `process_verified_withdrawal` RPC is removed by the current withdrawal migration. The existing general-purpose `apply_wallet_ledger_entry` RPC keeps its original allowed entry types; withdrawal-specific entries are written only within the new service-role-only reservation and release functions.

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
