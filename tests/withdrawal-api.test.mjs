import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { Keypair } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const solanaConfig = require("../server/lib/solana-deposit.js");
const withdrawalLibrary = require("../server/lib/withdrawals.js");
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
const withdrawalsHandler = require("../api/withdrawals.js");

let scenario;

function resetScenario({
    balance = 10000n,
    transferOutcome = "success",
    readBalanceOverride = null,
    accountMissing = false,
    ledgerBalanceOverride = null,
    completedLevels = Array.from({ length: 20 }, (_, index) => index + 1),
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
                amount_raw: "50000000",
                transaction_signature: record.signature,
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
            scenario.actualBalance -= amount;
            scenario.ledger.push({ type: "withdrawal_reserve", amount: -amount });
            const record = {
                id: `withdrawal-${scenario.records.size + 1}`,
                idempotencyKey: body.p_idempotency_key,
                playerId: body.p_player_id,
                walletAddress: body.p_wallet_address,
                amount,
                rawAmount: BigInt(body.p_amount_raw),
                status: "pending",
                signature: null
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
            scenario.actualBalance += record.amount;
            scenario.ledger.push({ type: "withdrawal_release", amount: record.amount });
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

test("successful withdrawal reserves credits once and confirms without a second balance mutation", async () => {
    const response = await submitWithdrawal();

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.status, "confirmed");
    assert.equal(response.payload.signature, signature);
    assert.equal(scenario.actualBalance, 5000n);
    assert.deepEqual(scenario.ledger.map((entry) => [entry.type, entry.amount]), [
        ["withdrawal_reserve", -5000n]
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
        requiredLevels: 20,
        completedLevels: 20,
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

test("withdrawal status stays disabled until all first 20 server-saved levels are complete", async () => {
    scenario.completedLevels = Array.from({ length: 19 }, (_, index) => index + 1);

    const response = await getWithdrawalStatus();

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.withdrawalEnabled, false);
    assert.deepEqual(response.payload.level20Requirement, {
        requiredLevels: 20,
        completedLevels: 19,
        remainingLevels: 1,
        met: false
    });
});

test("withdrawal eligibility combines persisted server point clears without double-counting overlaps", async () => {
    scenario.completedLevels = Array.from({ length: 10 }, (_, index) => index + 1);
    scenario.gamePointCompletions = [
        ...Array.from({ length: 10 }, (_, index) => index + 11),
        10
    ];

    const response = await getWithdrawalStatus();

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.level20Requirement.met, true);
    assert.equal(response.payload.level20Requirement.completedLevels, 20);
});

test("withdrawal request is rejected before reservation until levels 1 through 20 are server-saved", async () => {
    scenario.completedLevels = Array.from({ length: 19 }, (_, index) => index + 1);

    const response = await submitWithdrawal();

    assert.equal(response.statusCode, 403);
    assert.equal(response.payload.error, "level_20_required");
    assert.equal(response.payload.level20Requirement.remainingLevels, 1);
    assert.equal(scenario.records.size, 0);
    assert.equal(scenario.ledger.length, 0);
    assert.equal(scenario.sendCount, 0);
});

test("levels above 20 do not substitute for missing first-20 completion records", async () => {
    scenario.completedLevels = [
        ...Array.from({ length: 19 }, (_, index) => index + 1),
        ...Array.from({ length: 10 }, (_, index) => index + 21)
    ];

    const response = await getWithdrawalStatus();

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.level20Requirement.completedLevels, 19);
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

test("confirmed on-chain failure releases the reservation and restores the exact balance", async () => {
    scenario.transferOutcome = "failed";

    const response = await submitWithdrawal();

    assert.equal(response.statusCode, 502);
    assert.equal(response.payload.status, "failed");
    assert.equal(scenario.actualBalance, 10000n);
    assert.deepEqual(scenario.ledger.map((entry) => [entry.type, entry.amount]), [
        ["withdrawal_reserve", -5000n],
        ["withdrawal_release", 5000n]
    ]);
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
    const first = await submitWithdrawal();
    const second = await submitWithdrawal();

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(second.payload.status, "confirmed");
    assert.equal(scenario.records.size, 1);
    assert.equal(scenario.actualBalance, 5000n);
    assert.equal(scenario.ledger.length, 1);
    assert.equal(scenario.sendCount, 1);
});

test("ambiguous submitted transfers keep the balance reserved and block a second request", async () => {
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
    assert.equal(scenario.actualBalance, 5000n);
    assert.equal(scenario.ledger.length, 1);
    assert.equal([...scenario.records.values()][0].status, "submitted");
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
