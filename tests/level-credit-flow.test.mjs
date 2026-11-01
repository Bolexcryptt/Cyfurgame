import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { evaluateLevelStars, getLevelEconomy, getLevelStarTimeTargets, levels } from "../levels.js";

const require = createRequire(import.meta.url);
const { getLevelEntryCostCredits } = require("../server/lib/wallet.js");
const levelEntry = require("../api/level-entry.js");
const originalFetch = globalThis.fetch;
const originalEnvironment = { ...process.env };
const requestIds = [
    "123e4567-e89b-42d3-a456-426614174001",
    "123e4567-e89b-42d3-a456-426614174002",
    "123e4567-e89b-42d3-a456-426614174003"
];

function restoreEnvironment() {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(process.env)) {
        if (!(name in originalEnvironment)) delete process.env[name];
    }
    Object.assign(process.env, originalEnvironment);
}

function response(status, payload) {
    return new Response(payload === null ? null : JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

function createApiResponse() {
    return {
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        setHeader() {},
        json(payload) {
            this.payload = payload;
        }
    };
}

function configureEnvironment({ gameplayEnabled = false } = {}) {
    process.env.LEVELS_LOCKED = "false";
    process.env.SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    process.env.WALLET_PAID_GAMEPLAY_ENABLED = gameplayEnabled ? "true" : "false";
}

function installEntryDatabase({
    initialBalance,
    hasAccount = true,
    gameplayEnabled = false
}) {
    let balance = BigInt(initialBalance);
    let rpcTail = Promise.resolve();
    const sessions = new Map();
    let activeSession = null;
    let rpcCalls = 0;
    globalThis.fetch = async (input, options = {}) => {
        const url = new URL(input);
        const path = url.pathname.replace("/rest/v1/", "");
        if (url.pathname.endsWith("/auth/v1/user")) {
            return response(200, { id: "00000000-0000-4000-8000-000000000001" });
        }
        if (path.startsWith("wallet_credit_accounts")) {
            return response(200, hasAccount ? [{ balance_credits: balance.toString() }] : []);
        }
        if (path.startsWith("wallet_system_config")) {
            return response(200, [{ paid_gameplay_enabled: gameplayEnabled }]);
        }
        if (path === "rpc/start_wallet_level") {
            rpcCalls++;
            const body = JSON.parse(options.body);
            const operation = rpcTail.then(() => {
                const existing = sessions.get(body.p_request_id);
                if (existing) return response(200, [existing]);

                if (activeSession) {
                    if (activeSession.level_number !== body.p_level_number) {
                        return response(400, {
                            code: "55006",
                            message: "Another level session is already active."
                        });
                    }
                    sessions.set(body.p_request_id, activeSession);
                    return response(200, [activeSession]);
                }

                const cost = BigInt(getLevelEntryCostCredits(body.p_level_number));
                if (balance < cost) {
                    return response(400, { code: "P0001", message: "Insufficient credits." });
                }

                balance -= cost;
                const session = {
                    session_id: `session-${sessions.size + 1}`,
                    balance_credits: balance.toString(),
                    entry_cost_credits: cost.toString(),
                    level_number: body.p_level_number
                };
                activeSession = session;
                sessions.set(body.p_request_id, session);
                return response(200, [session]);
            });
            rpcTail = operation.then(() => undefined);
            return operation;
        }
        throw new Error(`Unexpected level-entry request: ${url}`);
    };
    return {
        get balance() { return balance; },
        get rpcCalls() { return rpcCalls; }
    };
}

async function enterLevel({ levelNumber = 1, requestId = requestIds[0] } = {}) {
    const apiResponse = createApiResponse();
    await levelEntry({
        method: "POST",
        headers: { authorization: "Bearer player-token" },
        body: { levelNumber, requestId }
    }, apiResponse);
    return apiResponse;
}

test("entry fees are floor(100 * 1.08^(level - 1)) for every level 1 through 99", () => {
    for (let levelNumber = 1; levelNumber <= 99; levelNumber++) {
        const expected = Math.floor(100 * Math.pow(1.08, levelNumber - 1));
        assert.equal(getLevelEntryCostCredits(levelNumber), expected, `level ${levelNumber}`);
        assert.equal(getLevelEconomy(levelNumber).entryCostCredits, expected, `level ${levelNumber}`);
    }
    assert.equal(getLevelEntryCostCredits(0), null);
    assert.equal(getLevelEntryCostCredits(100), null);
});

test("zero and insufficient balances are rejected with required fee and verified current balance", async (context) => {
    context.after(restoreEnvironment);
    configureEnvironment();

    for (const [balance, hasAccount] of [["0", false], ["99", true]]) {
        installEntryDatabase({ initialBalance: balance, hasAccount });
        const result = await enterLevel();
        assert.equal(result.statusCode, 402);
        assert.equal(result.payload.error, "insufficient_balance");
        assert.equal(result.payload.entryCostCredits, 100);
        assert.equal(result.payload.balanceCredits, balance);
        assert.equal(result.payload.balanceVerified, true);
    }
});

test("level 99 does not require earlier completions and still requires its entry fee", async (context) => {
    context.after(restoreEnvironment);
    configureEnvironment();
    installEntryDatabase({ initialBalance: "0" });

    const result = await enterLevel({ levelNumber: 99 });

    assert.equal(result.statusCode, 402);
    assert.equal(result.payload.error, "insufficient_balance");
    assert.equal(result.payload.entryCostCredits, getLevelEntryCostCredits(99));
});

test("exact entry-fee balance creates a server session and deducts once", async (context) => {
    context.after(restoreEnvironment);
    configureEnvironment({ gameplayEnabled: true });
    const database = installEntryDatabase({
        initialBalance: "100",
        gameplayEnabled: true
    });

    const result = await enterLevel();

    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.allowed, true);
    assert.equal(result.payload.sessionId, "session-1");
    assert.equal(result.payload.entryCostCredits, 100);
    assert.equal(result.payload.balanceCredits, "0");
    assert.equal(database.balance, 0n);
    assert.equal(database.rpcCalls, 1);
});

test("replaying an entry request returns the same session without charging twice", async (context) => {
    context.after(restoreEnvironment);
    configureEnvironment({ gameplayEnabled: true });
    const database = installEntryDatabase({
        initialBalance: "100",
        gameplayEnabled: true
    });

    const first = await enterLevel();
    const replay = await enterLevel();

    assert.equal(first.statusCode, 200);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.payload.sessionId, first.payload.sessionId);
    assert.equal(database.balance, 0n);
    assert.equal(database.rpcCalls, 2);
});

test("concurrent entry requests cannot spend the same exact balance twice", async (context) => {
    context.after(restoreEnvironment);
    configureEnvironment({ gameplayEnabled: true });
    const database = installEntryDatabase({
        initialBalance: "100",
        gameplayEnabled: true
    });

    const results = await Promise.all([
        enterLevel({ requestId: requestIds[0] }),
        enterLevel({ requestId: requestIds[1] })
    ]);

    assert.deepEqual(results.map((result) => result.statusCode), [200, 200]);
    assert.equal(results[0].payload.sessionId, results[1].payload.sessionId);
    assert.equal(results[1].payload.balanceCredits, "0");
    assert.equal(database.balance, 0n);
    assert.equal(database.rpcCalls, 2);
});

test("separate entry requests for the active level reuse its session without another charge", async (context) => {
    context.after(restoreEnvironment);
    configureEnvironment({ gameplayEnabled: true });
    const database = installEntryDatabase({
        initialBalance: "1000",
        gameplayEnabled: true,
        completions: [{ level_number: 1 }]
    });

    const first = await enterLevel({ levelNumber: 2, requestId: requestIds[0] });
    const second = await enterLevel({ levelNumber: 2, requestId: requestIds[1] });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.payload.sessionId, second.payload.sessionId);
    assert.equal(database.balance, 892n);
});

test("a distinct active session for another level is rejected without another charge", async (context) => {
    context.after(restoreEnvironment);
    configureEnvironment({ gameplayEnabled: true });
    const database = installEntryDatabase({
        initialBalance: "1000",
        gameplayEnabled: true,
        completions: [{ level_number: 1 }]
    });

    const first = await enterLevel({ levelNumber: 2, requestId: requestIds[0] });
    const second = await enterLevel({ levelNumber: 1, requestId: requestIds[1] });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 409);
    assert.equal(second.payload.error, "level_session_active");
    assert.equal(database.balance, 892n);
});

test("approved star rewards and failed attempts follow the existing completion-time rules", () => {
    for (const levelNumber of [1, 50, 99]) {
        const level = levels[levelNumber - 1];
        const economy = getLevelEconomy(levelNumber);
        const targets = getLevelStarTimeTargets(level);
        assert.deepEqual(
            evaluateLevelStars(level, targets.threeSeconds * 1000),
            { stars: 3, rewardCredits: Math.floor(economy.entryCostCredits * 1.6), status: "completed" }
        );
        assert.deepEqual(
            evaluateLevelStars(level, targets.twoSeconds * 1000),
            { stars: 2, rewardCredits: Math.floor(economy.entryCostCredits * 0.4), status: "completed" }
        );
        assert.deepEqual(
            evaluateLevelStars(level, (targets.twoSeconds + 1) * 1000),
            { stars: 1, rewardCredits: 0, status: "completed" }
        );
        assert.deepEqual(
            evaluateLevelStars(level, targets.threeSeconds * 1000, false),
            { stars: 0, rewardCredits: 0, status: "fail" }
        );
    }
});

test("the SQL accounting functions serialize entry and award rewards once per session", () => {
    const sql = readFileSync(new URL("../supabase-wallet-deposit-processing.sql", import.meta.url), "utf8");
    const start = sql.slice(
        sql.indexOf("create or replace function public.start_wallet_level("),
        sql.indexOf("create or replace function public.start_wallet_level_timer(")
    );
    const complete = sql.slice(
        sql.indexOf("create or replace function public.complete_wallet_level("),
        sql.indexOf("revoke all on function public.start_wallet_level(")
    );
    assert.match(start, /perform 1 from public\.player_profiles where id = p_player_id for update/);
    assert.match(start, /entry_request_id = p_request_id/);
    assert.match(start, /completed_at is null\s+and expires_at > now\(\)/);
    assert.match(start, /another level session is already active/i);
    assert.match(start, /'55006'/);
    assert.match(start, /'game_entry', -v_cost/);
    assert.doesNotMatch(start, /v_unlocked|Level is locked/i);
    assert.match(complete, /where id = p_session_id and player_id = p_player_id\s+for update/);
    assert.match(complete, /when 3 then floor\(v_session\.entry_cost_credits \* 1\.6\)::bigint/);
    assert.match(complete, /when 2 then floor\(v_session\.entry_cost_credits \* 0\.4\)::bigint/);
    assert.match(complete, /'game_reward', v_expected_reward/);
    assert.match(complete, /level-reward:' \|\| p_session_id::text/);
    assert.match(complete, /on conflict \(player_id, level_number\) do nothing/);
    assert.match(sql, /paid_gameplay_enabled = false/);
    const safetyMigration = readFileSync(new URL("../supabase-wallet-level-entry-safety.sql", import.meta.url), "utf8");
    assert.match(safetyMigration, /create or replace function public\.start_wallet_level\(/);
    assert.match(safetyMigration, /another level session is already active/i);
    assert.doesNotMatch(safetyMigration, /v_unlocked|Level is locked/i);
    assert.doesNotMatch(safetyMigration, /delete from|truncate|drop table|update public\.wallet_credit_accounts/i);
    const allLevelsMigration = readFileSync(new URL("../supabase-wallet-all-levels-access.sql", import.meta.url), "utf8");
    assert.match(allLevelsMigration, /create or replace function public\.start_wallet_level\(/);
    assert.match(allLevelsMigration, /if v_balance < v_cost then/i);
    assert.match(allLevelsMigration, /'game_entry', -v_cost/);
    assert.doesNotMatch(allLevelsMigration, /v_unlocked|Level is locked/i);
    assert.doesNotMatch(allLevelsMigration, /update public\.wallet_system_config|deposits_enabled\s*=/i);
    const depositAttributionMigration = readFileSync(
        new URL("../supabase-shared-treasury-deposit-attribution.sql", import.meta.url),
        "utf8"
    );
    assert.match(depositAttributionMigration, /player''s verified wallet/);
    assert.doesNotMatch(depositAttributionMigration, /player's verified wallet/);
});
