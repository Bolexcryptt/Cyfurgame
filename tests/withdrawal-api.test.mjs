import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const require = createRequire(import.meta.url);
const solanaConfig = require("../server/lib/solana-deposit.js");
const withdrawalLibrary = require("../server/lib/withdrawals.js");
const reconcileWithdrawal = withdrawalLibrary.reconcileFinalizedCyfurWithdrawal;
const officialTreasuryAddress = solanaConfig.RELICGRID_TREASURY_ADDRESS;
const officialMintAddress = solanaConfig.RELICGRID_CYFUR_MINT_ADDRESS;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const testTreasury = Keypair.generate();
const playerWallet = "4bSjz5zdgReegh9TwCgiPWn7BH1nUhfY3s1DwZdK3UT1";
const signature = withdrawalLibrary.encodeBase58(
    Uint8Array.from({ length: 64 }, (_, index) => (index + 1) % 256)
);

solanaConfig.RELICGRID_TREASURY_ADDRESS = testTreasury.publicKey.toBase58();
withdrawalLibrary.getWithdrawalSignerFromEnvironment = () => testTreasury;
withdrawalLibrary.executeCyfurWithdrawal = async ({ onSubmitted, amountRaw, playerWalletAddress }) => {
    scenario.sendCount += 1;
    scenario.transferRequest = { amountRaw, playerWalletAddress };
    await onSubmitted(signature);
    if (scenario.transferOutcome === "failed") {
        const error = new Error("On-chain transaction failed.");
        error.chainFailed = true;
        error.signature = signature;
        throw error;
    }
    if (scenario.transferOutcome === "ambiguous") {
        const error = new Error("Confirmation timed out.");
        error.submitted = true;
        error.signature = signature;
        throw error;
    }
    return { signature, status: "finalized" };
};
withdrawalLibrary.reconcileFinalizedCyfurWithdrawal = async () => ({
    state: scenario.reconcileOutcome
});
const withdrawalsHandler = require("../api/withdrawals.js");

let scenario;

function resetScenario({
    balance = 10000n,
    transferOutcome = "success",
    readBalanceOverride = null,
    accountMissing = false,
    ledgerBalanceOverride = null,
    completedLevels = Array.from({ length: 19 }, (_, index) => index + 1),
    gamePointCompletions = []
} = {}) {
    scenario = {
        actualBalance: balance,
        readBalanceOverride,
        accountMissing,
        ledgerBalanceOverride,
        completedLevels,
        gamePointCompletions,
        transferOutcome,
        reconcileOutcome: "pending",
        confirmFailureCount: 0,
        rateLimited: false,
        records: new Map(),
        ledger: [],
        sendCount: 0,
        transferRequest: null
    };
    process.env.SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    process.env.WITHDRAWAL_ENABLED = "true";
    process.env.SOLANA_NETWORK = "mainnet-beta";
    process.env.SOLANA_RPC_URL = "https://rpc.example.invalid";
}

function dbResponse(status, payload) {
    return new Response(payload === null ? null : JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

function installFakeFetch() {
    globalThis.fetch = async (input, options = {}) => {
        const url = new URL(input);
        const path = url.pathname.replace("/rest/v1/", "");
        if (url.pathname.endsWith("/auth/v1/user")) {
            return dbResponse(200, { id: "00000000-0000-4000-8000-000000000001" });
        }
        if (path.startsWith("player_solana_wallets")) {
            return dbResponse(200, [{
                wallet_address: playerWallet,
                verified_at: "2026-01-01T00:00:00Z"
            }]);
        }
        if (path.startsWith("wallet_credit_accounts")) {
            if (scenario.accountMissing) return dbResponse(200, []);
            const balance = scenario.readBalanceOverride ?? scenario.actualBalance;
            return dbResponse(200, [{ balance_credits: balance.toString() }]);
        }
        if (path.startsWith("wallet_credit_ledger")) {
            return dbResponse(200, scenario.ledgerBalanceOverride === null
                ? []
                : [{ balance_after_credits: scenario.ledgerBalanceOverride.toString() }]);
        }
        if (path.startsWith("wallet_system_config")) {
            return dbResponse(200, [{
                network: "mainnet-beta",
                official_mint_address: solanaConfig.RELICGRID_CYFUR_MINT_ADDRESS,
                token_program_id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                token_decimals: 8,
                treasury_address: testTreasury.publicKey.toBase58(),
                credits_per_token: 1000,
                deposits_enabled: false,
                withdrawals_enabled: true,
                withdrawal_rate_limit_per_hour: 5
            }]);
        }
        if (path.startsWith("wallet_withdrawals")) {
            return dbResponse(200, [...scenario.records.values()].map((record) => ({
                id: record.id,
                status: record.status,
                amount_credits: record.amount.toString(),
                amount_raw: record.rawAmount.toString(),
                wallet_address: record.walletAddress,
                idempotency_key: record.idempotencyKey,
                transaction_signature: record.signature,
                balance_deducted: record.balanceDeducted,
                created_at: "2026-01-01T00:00:00Z"
            })));
        }
        if (path.startsWith("level_completions")) {
            return dbResponse(200, scenario.completedLevels.map((level_number) => ({ level_number })));
        }
        if (path.startsWith("game_point_level_completions")) {
            return dbResponse(200, scenario.gamePointCompletions.map((level_number) => ({ level_number })));
        }
        if (path === "rpc/reserve_wallet_withdrawal") {
            if (scenario.rateLimited) {
                return dbResponse(400, {
                    code: "P0001",
                    message: "Withdrawal request rate limit exceeded."
                });
            }
            const body = JSON.parse(options.body);
            const prior = scenario.records.get(body.p_idempotency_key);
            if (prior) {
                if (prior.playerId !== body.p_player_id || prior.amount !== BigInt(body.p_amount_credits) ||
                    prior.walletAddress !== body.p_wallet_address) {
                    return dbResponse(409, { message: "Idempotency key was reused for a different withdrawal." });
                }
                return dbResponse(200, [{
                    withdrawal_id: prior.id,
                    withdrawal_status: prior.status,
                    transaction_signature: prior.signature,
                    balance_credits: scenario.actualBalance.toString(),
                    already_reserved: true
                }]);
            }
            if ([...scenario.records.values()].some((record) =>
                record.playerId === body.p_player_id && ["pending", "submitted"].includes(record.status))) {
                return dbResponse(409, { message: "A withdrawal is already pending reconciliation." });
            }
            const amount = BigInt(body.p_amount_credits);
            if (scenario.actualBalance < amount) {
                return dbResponse(400, { message: "Insufficient credits for withdrawal." });
            }
            const record = {
                id: `withdrawal-${scenario.records.size + 1}`,
                idempotencyKey: body.p_idempotency_key,
                playerId: body.p_player_id,
                walletAddress: body.p_wallet_address,
                amount,
                rawAmount: BigInt(body.p_amount_raw),
                status: "pending",
                signature: null,
                balanceDeducted: false
            };
            scenario.records.set(body.p_idempotency_key, record);
            return dbResponse(200, [{
                withdrawal_id: record.id,
                withdrawal_status: "pending",
                transaction_signature: null,
                balance_credits: scenario.actualBalance.toString(),
                already_reserved: false
            }]);
        }
        if (path === "rpc/mark_wallet_withdrawal_submitted") {
            const body = JSON.parse(options.body);
            const record = [...scenario.records.values()].find((item) => item.id === body.p_withdrawal_id);
            record.status = "submitted";
            record.signature = body.p_transaction_signature;
            return dbResponse(204, null);
        }
        if (path === "rpc/confirm_wallet_withdrawal") {
            const body = JSON.parse(options.body);
            const record = [...scenario.records.values()].find((item) => item.id === body.p_withdrawal_id);
            if (record.status !== "submitted" || record.signature !== body.p_transaction_signature) {
                return dbResponse(400, { message: "Only a matching submitted withdrawal can be confirmed." });
            }
            if (scenario.confirmFailureCount > 0) {
                scenario.confirmFailureCount -= 1;
                return dbResponse(500, { message: "Temporary database confirmation failure." });
            }
            if (!record.balanceDeducted) {
                scenario.actualBalance -= record.amount;
                scenario.ledger.push({ type: "withdrawal", amount: -record.amount });
                record.balanceDeducted = true;
            }
            record.status = "confirmed";
            return dbResponse(200, [{
                balance_credits: scenario.actualBalance.toString(),
                already_confirmed: false
            }]);
        }
        if (path === "rpc/release_wallet_withdrawal") {
            const body = JSON.parse(options.body);
            const record = [...scenario.records.values()].find((item) => item.id === body.p_withdrawal_id);
            if (record.status === "submitted" &&
                (!body.p_chain_failure_verified || record.signature !== body.p_transaction_signature)) {
                return dbResponse(400, { message: "Submitted withdrawal funds can only be released after verifying the transaction failed." });
            }
            if (record.balanceDeducted) {
                scenario.actualBalance += record.amount;
                scenario.ledger.push({ type: "withdrawal_release", amount: record.amount });
                record.balanceDeducted = false;
            }
            record.status = "failed";
            return dbResponse(200, [{
                balance_credits: scenario.actualBalance.toString(),
                already_released: false
            }]);
        }
        throw new Error(`Unexpected fake request: ${options.method || "GET"} ${url.pathname}`);
    };
}

async function submitWithdrawal({
    amount = "5000",
    requestId = "00000000-0000-4000-8000-000000000002",
    walletAddress = playerWallet
} = {}) {
    const response = {
        headers: {},
        statusCode: 200,
        payload: null,
        status(code) { this.statusCode = code; },
        setHeader(name, value) { this.headers[name] = value; },
        json(payload) { this.payload = payload; }
    };
    await withdrawalsHandler({
        method: "POST",
        headers: { authorization: "Bearer test-access-token" },
        body: { action: "submit", amountCredits: amount, walletAddress, idempotencyKey: requestId }
    }, response);
    return response;
}

async function getWithdrawalStatus() {
    const response = {
        headers: {},
        statusCode: 200,
        payload: null,
        status(code) { this.statusCode = code; },
        setHeader(name, value) { this.headers[name] = value; },
        json(payload) { this.payload = payload; }
    };
    await withdrawalsHandler({
        method: "GET",
        headers: { authorization: "Bearer test-session-token" }
    }, response);
    return response;
}

test.beforeEach(() => {
    resetScenario();
    installFakeFetch();
});

test.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
});

test("successful withdrawal deducts credits only after transfer confirmation", async () => {
    const response = await submitWithdrawal();

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.status, "confirmed");
    assert.equal(response.payload.signature, signature);
    assert.equal(scenario.actualBalance, 5000n);
    assert.deepEqual(scenario.ledger.map((entry) => [entry.type, entry.amount]), [
        ["withdrawal", -5000n]
    ]);
    assert.equal([...scenario.records.values()][0].status, "confirmed");
    assert.equal(scenario.sendCount, 1);
});

test("withdrawal status reports the authenticated player's balance and eligibility", async () => {
    const response = {
        headers: {},
        statusCode: 200,
        payload: null,
        status(code) { this.statusCode = code; },
        setHeader(name, value) { this.headers[name] = value; },
        json(payload) { this.payload = payload; }
    };
    await withdrawalsHandler({
        method: "GET",
        headers: { authorization: "Bearer test-session-token" }
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.balanceCredits, "10000");
    assert.equal(response.payload.availableCredits, "10000");
    assert.equal(response.payload.withdrawalEnabled, true);
    assert.equal(response.payload.activeWithdrawal, false);
    assert.deepEqual(response.payload.level20Requirement, {
        requiredLevels: 19,
        completedLevels: 19,
        remainingLevels: 0,
        met: true
    });

    test("withdrawal status falls back to the authenticated player's latest ledger balance", async () => {
        resetScenario({
            balance: 0n,
            accountMissing: true,
            ledgerBalanceOverride: 2800n
        });
        installFakeFetch();

        const response = await getWithdrawalStatus();

        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.balanceCredits, "2800");
        assert.equal(response.payload.availableCredits, "2800");
    });

    test("an existing zero account balance remains authoritative over an older ledger entry", async () => {
        resetScenario({
            balance: 0n,
            ledgerBalanceOverride: 2800n
        });
        installFakeFetch();

        const response = await getWithdrawalStatus();

        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.balanceCredits, "0");
        assert.equal(response.payload.availableCredits, "0");
    });
});

test("withdrawal status unlocks once the player reaches level 20", async () => {
    scenario.completedLevels = Array.from({ length: 18 }, (_, index) => index + 1);

    const response = await getWithdrawalStatus();

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.withdrawalEnabled, false);
    assert.deepEqual(response.payload.level20Requirement, {
        requiredLevels: 19,
        completedLevels: 18,
        remainingLevels: 1,
        met: false
    });

    scenario.completedLevels.push(19);
    const reachedLevel20 = await getWithdrawalStatus();
    assert.equal(reachedLevel20.statusCode, 200);
    assert.equal(reachedLevel20.payload.withdrawalEnabled, true);
    assert.deepEqual(reachedLevel20.payload.level20Requirement, {
        requiredLevels: 19,
        completedLevels: 19,
        remainingLevels: 0,
        met: true
    });
});

test("withdrawal eligibility combines persisted server point clears without double-counting overlaps", async () => {
    scenario.completedLevels = Array.from({ length: 10 }, (_, index) => index + 1);
    scenario.gamePointCompletions = [
        ...Array.from({ length: 9 }, (_, index) => index + 11),
        10
    ];

    const response = await getWithdrawalStatus();

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.level20Requirement.met, true);
    assert.equal(response.payload.level20Requirement.completedLevels, 19);
});

test("withdrawal request is rejected before reservation until levels 1 through 19 are server-saved", async () => {
    scenario.completedLevels = Array.from({ length: 18 }, (_, index) => index + 1);

    const response = await submitWithdrawal();

    assert.equal(response.statusCode, 403);
    assert.equal(response.payload.error, "level_20_required");
    assert.equal(response.payload.level20Requirement.remainingLevels, 1);
    assert.equal(scenario.records.size, 0);
    assert.equal(scenario.ledger.length, 0);
    assert.equal(scenario.sendCount, 0);
});

test("levels above 20 do not substitute for missing first-19 completion records", async () => {
    scenario.completedLevels = [
        ...Array.from({ length: 18 }, (_, index) => index + 1),
        ...Array.from({ length: 10 }, (_, index) => index + 21)
    ];

    const response = await getWithdrawalStatus();

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.level20Requirement.completedLevels, 18);
    assert.equal(response.payload.level20Requirement.remainingLevels, 1);
    assert.equal(response.payload.withdrawalEnabled, false);
});

test("one CYFUR withdrawal uses exactly 100000000 raw units for the pasted recipient", async () => {
    const recipientWallet = Keypair.generate().publicKey.toBase58();
    const response = await submitWithdrawal({ amount: "1000", walletAddress: recipientWallet });

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.amountRaw, "100000000");
    assert.equal(response.payload.walletAddress, recipientWallet);
    assert.deepEqual(scenario.transferRequest, {
        amountRaw: "100000000",
        playerWalletAddress: recipientWallet
    });
    assert.equal(scenario.sendCount, 1);
});

test("an invalid pasted Solana recipient is rejected before reservation", async () => {
    const response = await submitWithdrawal({ amount: "1000", walletAddress: "not-a-solana-address" });

    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.error, "invalid_wallet_address");
    assert.equal(scenario.records.size, 0);
    assert.equal(scenario.ledger.length, 0);
    assert.equal(scenario.sendCount, 0);
});

test("confirmed on-chain failure releases the reservation without deducting credits", async () => {
    scenario.transferOutcome = "failed";

    const response = await submitWithdrawal();

    assert.equal(response.statusCode, 502);
    assert.equal(response.payload.status, "failed");
    assert.equal(scenario.actualBalance, 10000n);
    assert.deepEqual(scenario.ledger, []);
    assert.equal([...scenario.records.values()][0].status, "failed");
});

test("atomic reservation rejects a balance that became insufficient after the API read", async () => {
    scenario.readBalanceOverride = 10000n;
    scenario.actualBalance = 1000n;

    const response = await submitWithdrawal();

    assert.equal(response.statusCode, 402);
    assert.equal(response.payload.error, "insufficient_balance");
    assert.equal(scenario.actualBalance, 1000n);
    assert.equal(scenario.records.size, 0);
    assert.equal(scenario.ledger.length, 0);
});

test("server-side withdrawal rate limit rejects the sixth request in a rolling hour", async () => {
    scenario.rateLimited = true;
    const response = await submitWithdrawal();
    assert.equal(response.statusCode, 429);
    assert.equal(response.payload.error, "withdrawal_rate_limited");
    assert.equal(scenario.sendCount, 0);
    assert.equal(scenario.records.size, 0);
});

test("replaying the same request idempotency key never submits or deducts twice", async () => {
    resetScenario({ balance: 5000n });
    installFakeFetch();
    const first = await submitWithdrawal();
    const second = await submitWithdrawal();

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(second.payload.status, "confirmed");
    assert.equal(scenario.records.size, 1);
    assert.equal(scenario.actualBalance, 0n);
    assert.equal(scenario.ledger.length, 1);
    assert.equal(scenario.sendCount, 1);
});

test("ambiguous submitted transfers reserve availability without deducting the balance", async () => {
    scenario.transferOutcome = "ambiguous";
    const first = await submitWithdrawal();
    const status = await getWithdrawalStatus();
    const second = await submitWithdrawal({
        requestId: "00000000-0000-4000-8000-000000000003"
    });

    assert.equal(first.statusCode, 202);
    assert.equal(first.payload.status, "submitted");
    assert.equal(status.payload.activeWithdrawal, true);
    assert.equal(second.statusCode, 409);
    assert.equal(scenario.actualBalance, 10000n);
    assert.equal(scenario.ledger.length, 0);
    assert.equal([...scenario.records.values()][0].status, "submitted");
});

test("a retry reconciles the recorded finalized transfer and deducts without resending", async () => {
    scenario.transferOutcome = "ambiguous";
    const first = await submitWithdrawal();
    scenario.reconcileOutcome = "finalized";
    const retry = await submitWithdrawal();

    assert.equal(first.statusCode, 202);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.payload.status, "confirmed");
    assert.equal(scenario.actualBalance, 5000n);
    assert.equal(scenario.ledger.length, 1);
    assert.equal(scenario.sendCount, 1);
});

test("a finalized failed retry releases its reservation without a debit or resend", async () => {
    scenario.transferOutcome = "ambiguous";
    await submitWithdrawal();
    scenario.reconcileOutcome = "failed";
    const retry = await submitWithdrawal();

    assert.equal(retry.statusCode, 502);
    assert.equal(retry.payload.status, "failed");
    assert.equal(scenario.actualBalance, 10000n);
    assert.equal(scenario.ledger.length, 0);
    assert.equal(scenario.sendCount, 1);
});

test("a finalized transfer is reconciled after its first database confirmation fails", async () => {
    resetScenario({ balance: 5000n });
    installFakeFetch();
    scenario.confirmFailureCount = 1;
    const first = await submitWithdrawal();
    scenario.reconcileOutcome = "finalized";
    const retry = await submitWithdrawal();

    assert.equal(first.statusCode, 202);
    assert.equal(retry.statusCode, 200);
    assert.equal(scenario.actualBalance, 0n);
    assert.equal(scenario.ledger.length, 1);
    assert.equal(scenario.sendCount, 1);
});

test("withdrawal reconciliation verifies the exact finalized transfer before credit settlement", async () => {
    const treasuryPublicKey = new PublicKey(officialTreasuryAddress);
    const mintPublicKey = new PublicKey(officialMintAddress);
    const playerPublicKey = new PublicKey(playerWallet);
    const treasuryTokenAccount = await getAssociatedTokenAddress(mintPublicKey, treasuryPublicKey);
    const playerTokenAccount = await getAssociatedTokenAddress(mintPublicKey, playerPublicKey);
    let amount = "100000000";
    const connectionFactory = () => ({
        async getGenesisHash() {
            return solanaConfig.GENESIS_HASHES["mainnet-beta"];
        },
        async getSignatureStatuses() {
            return { value: [{ confirmationStatus: "finalized", slot: 42, err: null }] };
        },
        async getParsedTransaction() {
            return {
                slot: 42,
                transaction: {
                    signatures: [signature],
                    message: {
                        accountKeys: [{ pubkey: treasuryPublicKey, signer: true }],
                        instructions: [{
                            programId: TOKEN_PROGRAM_ID,
                            parsed: {
                                type: "transferChecked",
                                info: {
                                    authority: officialTreasuryAddress,
                                    source: treasuryTokenAccount.toBase58(),
                                    destination: playerTokenAccount.toBase58(),
                                    mint: officialMintAddress,
                                    tokenAmount: { amount, decimals: 8 }
                                }
                            }
                        }]
                    }
                },
                meta: { err: null, innerInstructions: [] }
            };
        }
    });
    const input = {
        rpcUrl: "https://rpc.example.invalid",
        signature,
        playerWalletAddress: playerWallet,
        treasuryAddress: officialTreasuryAddress,
        mintAddress: officialMintAddress,
        tokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
        tokenDecimals: 8,
        amountRaw: "100000000",
        connectionFactory
    };

    assert.deepEqual(await reconcileWithdrawal(input), { state: "finalized" });
    amount = "99999999";
    assert.deepEqual(await reconcileWithdrawal(input), { state: "invalid" });
});

test("withdrawal migration preserves existing data and enforces service-only atomic state transitions", () => {
    const migration = readFileSync(new URL("../supabase-wallet-withdrawals.sql", import.meta.url), "utf8");

    assert.match(migration, /add column if not exists withdrawals_enabled boolean not null default false/);
    assert.match(migration, /add column if not exists withdrawal_rate_limit_per_hour integer not null default 5/i);
    assert.match(migration, /for update/);
    assert.match(migration, /withdrawal_reserve/);
    assert.match(migration, /withdrawal_release/);
    assert.match(migration, /Insufficient credits for withdrawal/);
    assert.match(migration, /create or replace function public\.enforce_wallet_withdrawal_rate_limit/i);
    assert.match(migration, /v_recent_count >= v_rate_limit/);
    assert.match(migration, /created_at > now\(\) - interval '1 hour'/i);
    assert.match(migration, /create trigger wallet_withdrawals_rate_limit/i);
    assert.match(migration, /p_chain_failure_verified is distinct from true/);
    assert.match(migration, /to service_role/);
    assert.match(migration, /create or replace function public\.reserve_wallet_withdrawal\(\s*p_player_id uuid,\s*p_wallet_address text,\s*p_network text,\s*p_mint_address text,\s*p_token_program_id text,\s*p_treasury_address text,\s*p_amount_raw bigint,\s*p_token_decimals integer,\s*p_amount_credits bigint,\s*p_idempotency_key text,\s*p_memo text default ''/i);
    assert.match(migration, /create or replace function public\.mark_wallet_withdrawal_submitted\(\s*p_withdrawal_id uuid,\s*p_transaction_signature text/i);
    assert.match(migration, /create or replace function public\.confirm_wallet_withdrawal\(\s*p_withdrawal_id uuid,\s*p_transaction_signature text/i);
    assert.match(migration, /create or replace function public\.release_wallet_withdrawal\(\s*p_withdrawal_id uuid,\s*p_failure_reason text,\s*p_chain_failure_verified boolean default false,\s*p_transaction_signature text default null/i);
    assert.match(migration, /drop function if exists public\.process_verified_withdrawal/);
    assert.match(migration, /notify pgrst,\s*'reload schema'/i);
    assert.doesNotMatch(migration, /set withdrawals_enabled\s*=\s*false/i);
    assert.doesNotMatch(migration, /truncate|delete from public\.wallet_credit_accounts|delete from public\.player_profiles/i);
});
