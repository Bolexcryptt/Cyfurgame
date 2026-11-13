# RelicGrid wallet integration

## Current design and safety

RelicGrid uses direct, non-custodial Solana deposits to the configured owner-controlled treasury. Players send from any Solana wallet and submit the transaction signature while signed in; no sending wallet connection or transaction memo is required. Withdrawals let signed-in players paste a Solana receiving address and enter a CYFUR amount; the server-held treasury signer sends the transfer. Withdrawal destinations are not ownership-verified, so players must verify the address before submission. RelicGrid does not request or store player private keys. Because the treasury is shared, a deposit without a memo is attributed to the first authenticated game account that submits its transaction signature.

## Player authentication and account recovery

The app restores a persisted authentication session and verifies it before loading player data. It creates an anonymous player identity only when no session exists; it never authenticates from a callsign or a `localStorage` player ID. The authenticated user ID is the permanent player identity: `player_profiles.id` references it, and progress, credit accounts, ledger entries, deposits, linked wallets, and withdrawals reference that profile ID. Linking a recovery email verifies ownership on the current session and preserves the same user ID, so no player rows or balances are migrated. Confirmation links return to the production RelicGrid site, where the app processes the authentication callback and removes token fragments from the browser address.

Wallet credits are read from the authenticated user's server account or latest ledger entry; they are never loaded from or saved to local player storage. If neither server record exists, the wallet reports an unverified balance instead of fabricating a zero. A normal Android app update using the same package ID and signing key preserves the app's local Supabase session. Uninstalling or clearing app data can remove an anonymous session, so players should link and verify a recovery email before reinstalling or changing devices.

On a new device or after reinstalling, a player can request an email OTP for an existing account. The flow disables user creation and the server allows switching from the new anonymous identity only after a read-only check confirms that identity has no saved player data. It fails closed if records cannot be checked or any player data exists. The recovery OTP signs into the existing player identity; the game then discards local cached progress and reloads the server profile, wallet balance, and progress under that user ID. Never merge balances by callsign, email text, or a client-supplied ID.

The authentication provider's built-in email sender and default templates may display its own brand. To send branded confirmation emails, configure a verified custom SMTP sender with the company display name and edit the email-change template to include both its confirmation link and one-time code. The provider Site URL must be the production app origin, and the confirmation callback URL must be on the provider's allowed redirect list.

Enable anonymous sign-ins, manual identity linking, and the Supabase email provider for the project. Configure the email templates to include the six-digit OTP used by the game. For a future Android or iOS client, use the same Supabase project and Auth user IDs, persist sessions with the platform's secure storage adapter, and send the Supabase access token as the API bearer token. Solana wallet ownership remains a separate proof: the user signs a server-issued message in an external wallet app, and the game stores only the verified public address. No seed phrase or private key is requested.

The server independently verifies the configured Solana network, exact CYFUR mint and token program, treasury token-account balance delta, actual transfer amount, successful finalized transaction, and a transaction signer. It calls a service-only Supabase RPC that rechecks treasury configuration, records the transaction signature uniquely, and applies the credit ledger entry atomically. Repeated submissions return the existing result rather than awarding credits again.

**Deposits and paid gameplay remain disabled by default.** Do not enable any deposit or paid-gameplay flags until the owner confirms the treasury, the deployed configuration matches Supabase, the migrations are applied, and devnet plus production-readiness checks pass. No real transfer or live Supabase write has been verified in this workspace.

The player-facing deposit flow displays the treasury address only; the player sends any amount of CYFUR from a wallet of their choice and submits the transaction signature (or a supported explorer link). The signature is only an untrusted lookup identifier until the server confirms the finalized transfer to the configured treasury. The game credits the authenticated account submitting that signature, using the actual on-chain amount. Since no memo or sender-wallet ownership proof identifies the intended player, the first valid account to submit a transaction receives its credit.

The configured treasury address has one code source of truth: `RELICGRID_TREASURY_ADDRESS` in `server/lib/solana-deposit.js` (`6KTSpvxGR2xvje3BG42QvmFjg2XLnFneCCSyVXhSKvys`). Supabase `wallet_system_config.treasury_address` must mirror that address and is rejected if it differs. The browser displays the server-returned address; no separate Vercel treasury-address variable is used. This code value is not independent proof of treasury ownership or owner approval.

The configured conversion is 1,000 off-chain wallet credits per CYFUR. At 8 token decimals, 1, 2, 5, 10, and 20 CYFUR convert to 1,000, 2,000, 5,000, 10,000, and 20,000 credits respectively. New deposits use the server-derived rate and finalized on-chain transfer amount, not the submitted link. Deposit history displays the verified token amount, credited balance, and transaction link. A submitted link is only an untrusted lookup identifier.

Changing the configured rate does not rewrite account balances, ledger rows, deposits, or withdrawals. Existing transaction amounts and statuses remain historical facts; any production rate change must wait until the balance, ledger, and withdrawal audit is complete and the corresponding database migration has been reviewed. Do not apply a rate change directly to production from the baseline schema files.

## Server game points

Legacy server game-point records remain separate from wallet credits and are not used to pay campaign entry. The current client does not award server game points for level completions. It records gameplay rewards in a separate device-local ledger; those amounts are not wallet credits, cannot pay entry fees, and are non-withdrawable. The player interface has one CYFUR transaction-ID submission form, which credits the verified wallet balance; there is no game-point deposit form.

Campaign entry fees are paid from the authenticated wallet-credit balance. Entry cost is `floor(100 × 1.08^(level - 1))`; the server checks the available balance and deducts the fee once per entry request. After a successful paid level, the client calculates the star reward and saves it immediately in a device-local ledger keyed by the paid entry session, preventing duplicate awards for that session. Three stars award 160% of the entry cost, two stars award 40%, and one star awards 0. This local result does not change the verified wallet balance or wallet ledger, cannot pay entry fees, and is not withdrawable or synchronized across devices. The client makes no timer-start or level-completion request, so server completion verification cannot delay the result or NEXT LEVEL. Locally cleared levels are not added to server completion records or the leaderboard and do not satisfy the existing first-30-level withdrawal gate; that gate continues to use server-saved completions.

## One-time treasury test transfer

`POST /api/treasury-test-transfer` is a separate, owner-only operation for the single approved mainnet test: exactly 100,000,000 raw CYFUR units (1 CYFUR) from the fixed treasury to `4bSjz5zdgReegh9TwCgiPWn7BH1nUhfY3s1DwZdK3UT1`. It does not read or alter player balances, credits, ledger rows, or normal withdrawal records. The API requires a 32-byte random base64url `CYFUR_TEST_TRANSFER_OWNER_TOKEN`, `CYFUR_TEST_TRANSFER_ENABLED=true`, explicit `SOLANA_NETWORK=mainnet-beta` and `SOLANA_RPC_URL`, the existing server-side treasury signing key, the Supabase service-role configuration, and `VERCEL_ENV=production`. The route stays disabled unless the owner token and enable flag are configured. Never put the owner token or signing key in browser code.

The request must use the exact approved recipient and amount, include the confirmation phrase `SEND EXACTLY 1 CYFUR TO APPROVED TEST WALLET`, and supply a UUID idempotency key. A durable, globally unique Supabase record reserves this specific transfer before signing. It is never cleared or retried automatically: any existing record blocks another send, including requests with a different idempotency key. Before signing, the API verifies mainnet genesis, finalized mint and treasury token account, the exact recipient ATA, treasury SOL/CYFUR funds, current ATA rent, and estimated transaction fee. It records the signature before broadcast, waits for finalized confirmation, and verifies the recipient balance increased by exactly 100,000,000 raw units. An ambiguous result remains reserved for manual reconciliation; it must not be retried.

Apply `supabase-cyfur-treasury-test-transfer.sql` to the same Supabase project used by the API before enabling the route. Configure the owner token and `CYFUR_TEST_TRANSFER_ENABLED` only for the short, owner-approved test window. The route is not invoked during deployment and this repository does not submit a mainnet transfer.

`GET /api/treasury-test-transfer` is a read-only check on the dedicated test-transfer route. It requires the same owner token but does not reserve the one-time transfer, sign, create accounts, or submit transactions. It verifies the configured gates, signer address, Supabase service-role access and existing reservation, then reads finalized mainnet balances, mint, recipient ATA, current rent, and estimated fee. It reports `readyToExecute` only when every required gate passes and no one-time record exists. `POST` remains the separate owner-authorized transfer operation and retains its fixed recipient, amount, and idempotency safeguards.

## Campaign access

All 99 levels can be selected in any order. Free practice is available when the player is unauthenticated or the server cannot verify an entry; practice does not charge credits or award local rewards. Authenticated campaign entries are reserved and charged from wallet credits by the wallet API when paid gameplay is enabled in both Vercel and Supabase. The `LEVELS_LOCKED=true` server setting blocks new level sessions.

## Required setup

Apply these SQL files in order in the Supabase SQL Editor if not already applied:

1. `supabase-leaderboard.sql`
2. `supabase-game-points.sql`
3. `supabase-game-points-verified-claims.sql`
4. `supabase-wallet.sql`
5. `supabase-wallet-deposit-processing.sql`
6. `supabase-direct-treasury-deposits.sql`
7. `supabase-payment-intents.sql`
8. `supabase-walletless-deposits.sql`
9. `supabase-shared-treasury-deposit-attribution.sql`
10. `supabase-game-points-cyfur-deposits.sql`
11. `supabase-wallet-transaction-id-deposits.sql`
12. `supabase-deposit-readiness.sql`
13. `supabase-wallet-withdrawals.sql`
14. `supabase-wallet-level-entry-safety.sql`
15. `supabase-wallet-all-levels-access.sql`
16. `supabase-wallet-output-ambiguity-fix.sql`
17. `supabase-wallet-local-completions.sql`
18. `supabase-relicgrid-treasury.sql` (only after the required production review and owner approval)
19. `supabase-cyfur-treasury-test-transfer.sql` (only when preparing the separate, owner-authorized one-time test)

The direct-treasury migration adds the treasury address and service-only RPCs. Wallet-link tables remain for existing wallet features but are not required for deposits or withdrawals. Wallet payment-intent tables and RPCs are retained for compatibility; the current player-facing deposit flow does not use them. The shared-treasury attribution migration records the verified sender from Solana RPC. The game-point deposit migration and transaction-ID deposit migration make transaction signatures single-use across wallet credits and game points and preserve existing balances. The read-only deposit-readiness migration checks the required tables, RPCs, service-role permissions, unique transaction constraints, and ledger idempotency constraint; missing schema or access fails closed. It does not enable deposits or change player data. The treasury migration updates `wallet_system_config.treasury_address` to the code value and enables deposits while keeping paid gameplay disabled. Do not apply it until the owner approves enabling live deposits after all readiness checks and testing. The withdrawal migration adds `withdrawals_enabled=false`, a `withdrawal_rate_limit_per_hour=5` setting, and service-only reserve, submit, confirm, and release RPCs. It records negative reservation and positive release entries in the existing credit ledger; it does not change current balances, game scores, progress, or leaderboard rows during migration. A database insert trigger serializes and enforces the five-request rolling-hour limit. Production database state cannot be verified from this repository; apply and check migrations in the intended Supabase project before deployment. Reapplying `supabase-wallet-withdrawals.sql` is idempotent; editing this file alone does not update a live database. Existing pending/submitted withdrawal rows must be reconciled before new withdrawals; never clear them manually to free a reservation.

The wallet-level-entry migrations define the wallet-credit entry RPC used by campaign entry. Apply `supabase-wallet-local-completions.sql` after `supabase-wallet-output-ambiguity-fix.sql` so an open session from a local-only completion cannot block a subsequent paid entry. This migration keeps the existing price formula, sufficient-balance check, and entry-request idempotency; it does not award completion rewards. `supabase-game-points.sql` continues to manage separate historical server game-point records, which do not fund campaign entry. Code changes alone do not update a live Supabase schema or API.

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

## Treasury deposit flow

The UI shows the configured treasury wallet and a transaction-ID field. `POST /api/deposits` takes the authenticated player's transaction signature or supported explorer link and queries the configured Solana RPC at finalized commitment. The server verifies the RPC network, official mint and token program, signed transfer instruction, treasury token-account balance delta, and actual amount; no transaction memo, pre-created amount, or linked sender wallet is required. A failed, pending, wrong-destination, or uncreditable transaction is not credited. The service-only `process_verified_transaction_deposit` RPC rechecks the treasury configuration, serializes duplicate claims, and atomically records the deposit and applies the ledger credit. The expected treasury associated token account must exist before deposits are enabled.

Wallet-link endpoints remain for the app's separate wallet features; deposits and withdrawals do not require them. Deposit verification only requires the authenticated player and transaction ID. Because a shared treasury cannot identify the intended player from a no-memo transfer, the first signed-in account that submits a valid signature gets the credit. Do not share transaction IDs before claiming a deposit.

The credit formula is **1 CYFUR = 1,000 credits**. Each individual transfer uses integer floor rounding:

`credits = floor(raw_token_amount × 1,000 ÷ 10^token_decimals)`

Fractional-credit remainders are discarded per transaction; they do not carry across deposits. Transfers that convert to zero credits are rejected. With an 8-decimal mint, 100,000 raw units (0.001 CYFUR) equal 1 credit.

## Withdrawal accounting and recovery

Players need server-saved completion records for levels 1-20 to unlock withdrawals. They sign in, paste a valid Solana receiving address, and request a CYFUR amount up to their available balance. Amounts convert at 1,000 credits per CYFUR; the smallest supported step is 0.001 CYFUR (1 credit). Requests are subject to a five-request rolling-hour database-enforced limit. The address is not ownership-verified; players must carefully check it because confirmed transfers cannot be reversed. No wallet connection or signature is requested. The API is mainnet-only. It first calls `reserve_wallet_withdrawal`, which locks the player's credit account, verifies the DB withdrawal switch and conversion, records the unique request, reserves the credits, and writes one `withdrawal_reserve` ledger entry atomically. A database trigger serializes all inserts for that player and enforces the rolling-hour limit. Only then is a treasury transfer signed server-side. Before signing, the backend verifies finalized mint and treasury token accounts, checks/creates the recipient ATA, queries current ATA rent and message fees, and ensures the treasury has sufficient SOL and CYFUR. The locally derived transaction signature is recorded via `mark_wallet_withdrawal_submitted` before broadcast. After finalized confirmation, the backend verifies the recipient balance increased by exactly the requested amount and records the withdrawal with `confirm_wallet_withdrawal`; confirmation does not debit a second time. A pre-broadcast failure releases the reservation with `release_wallet_withdrawal`. A submitted transfer is released only after the backend has verified the transaction failed on-chain. Timeouts and uncertain submission keep the reservation and block another active withdrawal until reconciled. The same client request ID is reused on retries; confirmed or failed records cannot be replayed into another transfer.

The former `process_verified_withdrawal` RPC is removed by the current withdrawal migration. The existing general-purpose `apply_wallet_ledger_entry` RPC keeps its original allowed entry types; withdrawal-specific entries are written only within the new service-role-only reservation and release functions.

## Test and launch checklist

1. Apply the migrations and verify the functions, table permissions, and RLS policies in Supabase.
2. Confirm the official CYFUR mint with the owner; set the mint, legacy Token Program ID, decimals, network, and `credits_per_token = 1000` in `wallet_system_config`.
3. Use a devnet test mint and devnet treasury first. Send from any test wallet with no memo; test wrong destination, wrong mint, failed and unfinalized transactions, fractional rounding, duplicate signature retries, and verified balance persistence.
4. Test transaction-ID attribution, amount conversion, failed transactions, and replay against a deployed Supabase/RPC setup before enabling deposits.
5. Confirm the transaction unique constraint and atomic ledger behavior using the deployed Supabase RPC. Do not use real player data for test resets.
6. Only after owner approval and a successful controlled test should production treasury/network configuration be prepared. Keep the mainnet and paid-gameplay flags off until a separate production review.

Automated local tests cover deterministic conversion, wallet-signature verification for the legacy wallet-link endpoint, signed-source and destination checks, finality outcomes, feature gates, and SQL invariants. They do not apply SQL, validate Supabase RPC behavior, access Vercel configuration, or prove a real on-chain deposit. No real deposit or production deployment was performed as part of this change.

## Economy and gameplay

Wallet entry prices are unchanged. Completion time selects one of three local reward tiers:

- Entry cost: `floor(100 × 1.08^(level − 1))`
- Three-star payout: `floor(entry cost × 1.6)`
- Two-star refund: `floor(entry cost × 0.4)`
- One-star completion or failure: `0`
- Three stars: finish at or below a par-derived threshold from 10 to 20 seconds.
- Two stars: finish after the three-star threshold and at or below a threshold from 30 to 40 seconds.
- One star: finish after the two-star threshold.

Paid campaign entry still deducts its fee from the verified wallet through the server. A successful paid completion adds its star-rated reward to the device's separate local-game-reward balance once per entry session. The completion screen immediately shows the stars, exact reward, and timing cutoffs. That local reward is not a verified wallet credit, cannot fund another entry, and cannot be withdrawn. Local campaign progress is saved on the device and is not server-synced.

Skipping an active paid level records that level locally as skipped and awards no stars or reward; its already charged entry fee is not refunded. The next level opens only after its normal entry fee is verified and charged through the existing wallet-entry ledger path. Insufficient balance or a free-practice session cannot record a skip. Skipped levels are shown separately from completed levels.

Every time a level is entered, a seeded variant generator rearranges the source, battery, mirrors, crystals, and obstacles while retaining that level's mirror par, crystal count, obstacle count, entry fee, reward amounts, and time thresholds. The app stores each used layout per level and excludes all previous layouts on later replays. Each candidate is checked against its generated mirror solution and full crystal route before it can be loaded; generation fails explicitly rather than returning an invalid layout.

The current client does not call the level timer or completion endpoints. Completion rewards and campaign progress are local and immediate; the server does not verify puzzle proof or award a wallet reward for this client flow. Wallet entry fees, deposits, and withdrawals remain server-authoritative. The new entry migration removes only the stale active-session restriction needed to continue paying for later levels; it does not alter player balances or ledger history. Automated tests do not replace live database and production verification.
