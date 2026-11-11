import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { levels } from "../levels.js";

const require = createRequire(import.meta.url);
const gamePoints = require("../server/lib/game-points.js");
const levelEntry = require("../api/level-entry.js");
const levelCompletion = require("../api/level-completion.js");
const {
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS,
    deriveAssociatedTokenAccount
} = require("../server/lib/solana-deposit.js");
const originalFetch = globalThis.fetch;
const originalEnvironment = { ...process.env };
const signature = encodeBase58(Buffer.alloc(64, 7));
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const playerId = "00000000-0000-4000-8000-000000000001";
const sourceWallet = "11111111111111111111111111111111";
const tokenProgramId = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const sourceTokenAccount = "Stake11111111111111111111111111111111111111";
const treasuryTokenAccount = deriveAssociatedTokenAccount(
    RELICGRID_TREASURY_ADDRESS,
    RELICGRID_CYFUR_MINT_ADDRESS,
    tokenProgramId
);

let scenario;

function encodeBase58(bytes) {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
    let encoded = "";
    while (value > 0n) {
        encoded = alphabet[Number(value % 58n)] + encoded;
        value /= 58n;
    }
    for (const byte of bytes) {
        if (byte !== 0) break;
        encoded = `1${encoded}`;
    }
    return encoded;
}

function dbResponse(status, payload) {
    return new Response(payload === null ? null : JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

function makeResponse() {
    return {
        statusCode: 200,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        setHeader(name, value) { this.headers[name] = value; },
        json(payload) { this.payload = payload; }
    };
}

function makeDepositTransaction(amountRaw = "250000000", authority = sourceWallet) {
    return {
        slot: 77,
        blockTime: 1700000000,
        transaction: {
            signatures: [signature],
            message: {
                accountKeys: [
                    { pubkey: authority, signer: true },
                    sourceTokenAccount,
                    treasuryTokenAccount
                ],
                instructions: [{
                    programId: tokenProgramId,
                    parsed: {
                        type: "transferChecked",
                        info: {
                            mint: RELICGRID_CYFUR_MINT_ADDRESS,
                            source: sourceTokenAccount,
                            destination: treasuryTokenAccount,
                            authority,
                            tokenAmount: { amount: amountRaw }
                        }
                    }
                }]
            }
        },
        meta: {
            err: null,
            preTokenBalances: [{
                accountIndex: 1,
                mint: RELICGRID_CYFUR_MINT_ADDRESS,
                owner: authority,
                uiTokenAmount: { amount: "500000000" }
            }],
            postTokenBalances: [
                {
                    accountIndex: 1,
                    mint: RELICGRID_CYFUR_MINT_ADDRESS,
                    owner: authority,
                    uiTokenAmount: { amount: String(500000000n - BigInt(amountRaw)) }
                },
                {
                    accountIndex: 2,
                    mint: RELICGRID_CYFUR_MINT_ADDRESS,
                    owner: RELICGRID_TREASURY_ADDRESS,
                    uiTokenAmount: { amount: amountRaw }
                }
            ]
        }
    };
}

function resetScenario() {
    scenario = {
        genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        transactionStatus: { confirmationStatus: "finalized", err: null, slot: 77 },
        transaction: makeDepositTransaction(),
        balancePoints: "4321",
        completedLevels: [2, 4],
        elapsedMilliseconds: 1000,
        claimResult: { balance_points: "6821", already_claimed: false, amount_points: "2500" },
        rpcClaimCalls: [],
        entryCalls: [],
        completionCalls: [],
        completionRpcError: null,
        sessionCompletedAt: null,
        lastCompletion: null,
        entryResponse: {
            session_id: sessionId,
            balance_points: "4221",
            entry_cost_points: "100"
        }
    };
    Object.assign(process.env, {
        SUPABASE_URL: "https://supabase.example",
        SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
        SOLANA_NETWORK: "devnet",
        SOLANA_RPC_URL: "https://rpc.example.invalid",
        LEVELS_LOCKED: "false"
    });

    globalThis.fetch = async (input, options = {}) => {
        const url = new URL(input);
        const path = url.pathname.replace("/rest/v1/", "");
        if (url.pathname.endsWith("/auth/v1/user")) {
            return dbResponse(200, { id: "00000000-0000-4000-8000-000000000001" });
        }
        if (url.origin === "https://rpc.example.invalid") {
            const { method } = JSON.parse(options.body);
            if (method === "getGenesisHash") return dbResponse(200, { result: scenario.genesisHash });
            if (method === "getSignatureStatuses") {
                return dbResponse(200, { result: { value: [scenario.transactionStatus] } });
            }
            if (method === "getTransaction") return dbResponse(200, { result: scenario.transaction });
            if (method === "getAccountInfo") {
                const [address] = JSON.parse(options.body).params;
                const account = address === RELICGRID_TREASURY_ADDRESS
                    ? { owner: "11111111111111111111111111111111", data: ["", "base64"] }
                    : address === treasuryTokenAccount
                        ? { owner: tokenProgramId, data: { parsed: { type: "account", info: {
                            mint: RELICGRID_CYFUR_MINT_ADDRESS,
                            owner: RELICGRID_TREASURY_ADDRESS
                        } } } }
                        : { owner: tokenProgramId, data: { parsed: { type: "mint", info: {
                            decimals: 8,
                            mintAuthority: null,
                            freezeAuthority: null
                        } } } };
                return dbResponse(200, { result: { value: account } });
            }
        }
        if (path.startsWith("wallet_system_config")) {
            return dbResponse(200, [{
                network: "devnet",
                official_mint_address: RELICGRID_CYFUR_MINT_ADDRESS,
                token_program_id: tokenProgramId,
                token_decimals: 8,
                credits_per_token: 1000,
                rounding_policy: "floor",
                treasury_address: RELICGRID_TREASURY_ADDRESS
            }]);
        }
        if (path.startsWith("player_solana_wallets")) {
            return dbResponse(200, scenario.linkedWallet === null
                ? []
                : [{ wallet_address: scenario.linkedWallet ?? sourceWallet }]);
        }
        if (path.startsWith("game_point_accounts")) {
            return dbResponse(200, [{ balance_points: scenario.balancePoints }]);
        }
        if (path.startsWith("game_point_level_completions")) {
            return dbResponse(200, scenario.completedLevels.map((level_number) => ({ level_number })));
        }
        if (path.startsWith("game_point_level_sessions")) {
            return dbResponse(200, [{
                id: sessionId,
                player_id: "00000000-0000-4000-8000-000000000001",
                level_number: 1,
                timer_started_at: new Date(Date.now() - scenario.elapsedMilliseconds).toISOString(),
                expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                completed_at: scenario.sessionCompletedAt
            }]);
        }
        if (path === "rpc/credit_verified_cyfur_game_points") {
            const body = JSON.parse(options.body);
            scenario.rpcClaimCalls.push(body);
            return dbResponse(200, [scenario.claimResult]);
        }
        if (path === "rpc/start_game_point_level") {
            scenario.entryCalls.push(JSON.parse(options.body));
            return dbResponse(200, [scenario.entryResponse]);
        }
        if (path === "rpc/complete_game_point_level") {
            const body = JSON.parse(options.body);
            scenario.completionCalls.push(body);
            if (scenario.completionRpcError) {
                return dbResponse(400, {
                    code: scenario.completionRpcError,
                    message: "Completion RPC failed."
                });
            }
            if (scenario.sessionCompletedAt) {
                return dbResponse(200, [{
                    balance_points: "5321",
                    stars: scenario.lastCompletion.p_stars,
                    reward_points: scenario.lastCompletion.p_reward_points,
                    elapsed_milliseconds: scenario.lastCompletion.p_elapsed_milliseconds,
                    already_completed: true
                }]);
            }
            scenario.lastCompletion = body;
            scenario.sessionCompletedAt = new Date().toISOString();
            return dbResponse(200, [{
                balance_points: "5321",
                stars: body.p_stars,
                reward_points: body.p_reward_points,
                elapsed_milliseconds: body.p_elapsed_milliseconds,
                already_completed: false
            }]);
        }
        throw new Error(`Unexpected API request: ${options.method || "GET"} ${url}`);
    };
}

async function call(handler, method, body, url = "/") {
    const response = makeResponse();
    await handler({
        method,
        url,
        headers: { authorization: "Bearer test-access-token" },
        body
    }, response);
    return response;
}

function restoreEnvironment() {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(process.env)) {
        if (!(name in originalEnvironment)) delete process.env[name];
    }
    Object.assign(process.env, originalEnvironment);
}

test.beforeEach(resetScenario);
test.after(restoreEnvironment);

test("authenticated game-points balance and clears load from the server ledger", async () => {
    const response = await call(gamePoints, "GET");

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload, {
        balancePoints: "4321",
        completedLevels: [2, 4]
    });
});

test("the public game-points route dispatches through the existing level-entry function", async () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.deepEqual(config.rewrites, [{
        source: "/api/game-points",
        destination: "/api/level-entry?route=game-points"
    }]);

    const response = await call(levelEntry, "GET", undefined, "/api/level-entry?route=game-points");

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload, {
        balancePoints: "4321",
        completedLevels: [2, 4]
    });
});

test("level entry charges the formula cost through an idempotent server session", async () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174001";
    const response = await call(levelEntry, "POST", {
        levelNumber: 1,
        requestId,
        gamePoints: true
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload, {
        allowed: true,
        gamePoints: true,
        sessionId,
        balancePoints: "4221",
        entryCostPoints: "100"
    });
    assert.deepEqual(scenario.entryCalls, [{
        p_player_id: "00000000-0000-4000-8000-000000000001",
        p_level_number: 1,
        p_request_id: requestId
    }]);
});

test("replaying a level-entry request reuses the same idempotency key and session", async () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174002";
    const body = { levelNumber: 1, requestId, gamePoints: true };
    const first = await call(levelEntry, "POST", body);
    const replay = await call(levelEntry, "POST", body);

    assert.equal(first.statusCode, 200);
    assert.equal(replay.statusCode, 200);
    assert.equal(first.payload.sessionId, replay.payload.sessionId);
    assert.equal(scenario.entryCalls.length, 2);
    assert.equal(scenario.entryCalls[0].p_request_id, requestId);
    assert.equal(scenario.entryCalls[1].p_request_id, requestId);
});

test("three-star, two-star, one-star, and failed level outcomes receive only their matching points", async () => {
    const level = levels[0];
    const mirrors = level.solutionMirrors.map(({ row, col, orientation }) => ({
        row,
        col,
        slash: orientation === "/"
    }));
    const outcomes = [
        { elapsed: Math.max(0, level.starTimeTargets.threeSeconds * 1000 - 60000), stars: 3, reward: "160" },
        { elapsed: Math.ceil((level.starTimeTargets.threeSeconds + level.starTimeTargets.twoSeconds) * 500), stars: 2, reward: "40" },
        { elapsed: (level.starTimeTargets.twoSeconds + 1) * 1000, stars: 1, reward: "0" }
    ];

    for (const outcome of outcomes) {
        resetScenario();
        scenario.elapsedMilliseconds = outcome.elapsed;
        const response = await call(levelCompletion, "POST", {
            sessionId,
            mirrors,
            launchDirection: level.start.direction,
            gamePoints: true
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.stars, outcome.stars);
        assert.equal(response.payload.rewardPoints, outcome.reward);
        assert.equal(scenario.completionCalls[0].p_reward_points, Number(outcome.reward));
    }

    resetScenario();
    scenario.elapsedMilliseconds = Math.max(0, level.starTimeTargets.threeSeconds * 1000 - 5000);
    const failed = await call(levelCompletion, "POST", {
        sessionId,
        mirrors: [{ row: -1, col: 0, slash: true }],
        launchDirection: level.start.direction,
        gamePoints: true
    });
    assert.equal(failed.statusCode, 422);
    assert.equal(failed.payload.error, "battery_not_connected");
    assert.equal(scenario.completionCalls.length, 0);
});

test("completion RPC failures include a safe diagnostic stage and database code", async () => {
    const level = levels[0];
    scenario.completionRpcError = "XX000";
    const response = await call(levelCompletion, "POST", {
        sessionId,
        mirrors: level.solutionMirrors.map(({ row, col, orientation }) => ({
            row,
            col,
            slash: orientation === "/"
        })),
        launchDirection: level.start.direction,
        gamePoints: true
    });

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.payload, {
        error: "level_completion_unavailable",
        diagnosticCode: "XX000",
        stage: "completion_rpc"
    });
});

test("replaying a completed level session returns its prior record without another award", async () => {
    const level = levels[0];
    scenario.elapsedMilliseconds = Math.max(0, level.starTimeTargets.threeSeconds * 1000 - 1000);
    const body = {
        sessionId,
        mirrors: level.solutionMirrors.map(({ row, col, orientation }) => ({
            row,
            col,
            slash: orientation === "/"
        })),
        launchDirection: level.start.direction,
        gamePoints: true
    };

    const first = await call(levelCompletion, "POST", body);
    const replay = await call(levelCompletion, "POST", body);

    assert.equal(first.statusCode, 200);
    assert.equal(first.payload.rewardPoints, "160");
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.payload.duplicate, true);
    assert.equal(replay.payload.rewardPoints, "160");
    assert.equal(scenario.completionCalls.length, 2);
    assert.equal(scenario.completionCalls[0].p_reward_points, 160);
    assert.equal(scenario.completionCalls[1].p_reward_points, 0);
});

test("a fresh paid session earns its reward even when that level was cleared before", async () => {
    const level = levels[0];
    scenario.completedLevels = [1, 2, 4];
    scenario.elapsedMilliseconds = Math.max(0, level.starTimeTargets.threeSeconds * 1000 - 1000);
    const response = await call(levelCompletion, "POST", {
        sessionId,
        mirrors: level.solutionMirrors.map(({ row, col, orientation }) => ({
            row,
            col,
            slash: orientation === "/"
        })),
        launchDirection: level.start.direction,
        gamePoints: true
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.duplicate, false);
    assert.equal(response.payload.rewardPoints, "160");
    assert.equal(scenario.completionCalls.length, 1);
    assert.equal(scenario.completionCalls[0].p_reward_points, 160);
});

test("a finalized treasury transfer credits the exact CYFUR-to-points amount", async () => {
    const response = await call(gamePoints, "POST", { action: "verify-deposit", signature });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload, {
        status: "confirmed",
        claimed: true,
        amountRaw: "250000000",
        tokenDecimals: 8,
        claimedPoints: "2500",
        balancePoints: "6821",
        transactionSignature: signature
    });
    assert.deepEqual(scenario.rpcClaimCalls, [{
        p_player_id: playerId,
        p_transaction_signature: signature,
        p_network: "devnet",
        p_finalized_slot: 77,
        p_amount_raw: "250000000",
        p_token_decimals: 8,
        p_mint_address: RELICGRID_CYFUR_MINT_ADDRESS,
        p_token_program_id: tokenProgramId,
        p_treasury_address: RELICGRID_TREASURY_ADDRESS
    }]);
});

test("pending, missing, failed, wrong-network, and unverifiable transactions never reach the credit RPC", async () => {
    const cases = [
        {
            update: () => { scenario.transactionStatus = { confirmationStatus: "confirmed", err: null, slot: 77 }; },
            expectedStatus: 202,
            expectedError: "pending"
        },
        {
            update: () => { scenario.transactionStatus = null; },
            expectedStatus: 404,
            expectedError: "transaction_not_found"
        },
        {
            update: () => { scenario.transactionStatus = { confirmationStatus: "finalized", err: { failed: true }, slot: 77 }; },
            expectedStatus: 422,
            expectedError: "transaction_failed"
        },
        {
            update: () => { scenario.genesisHash = "wrong-network"; },
            expectedStatus: 503,
            expectedError: "solana_rpc_network_mismatch"
        },
        {
            update: () => { scenario.transaction = null; },
            expectedStatus: 503,
            expectedError: "transaction_verification_unavailable"
        }
    ];

    for (const item of cases) {
        resetScenario();
        item.update();
        const response = await call(gamePoints, "POST", { action: "verify-deposit", signature });
        assert.equal(response.statusCode, item.expectedStatus);
        assert.equal(response.payload.error || response.payload.status, item.expectedError);
        assert.equal(scenario.rpcClaimCalls.length, 0);
    }
});

test("a transaction ID is sufficient without linking the sending wallet or adding a memo", async () => {
    scenario.linkedWallet = null;
    const unlinked = await call(gamePoints, "POST", { action: "verify-deposit", signature });
    assert.equal(unlinked.statusCode, 200);
    assert.equal(unlinked.payload.claimedPoints, "2500");
    assert.equal(scenario.rpcClaimCalls.length, 1);

    resetScenario();
    scenario.transaction = makeDepositTransaction("250000000", "Stake11111111111111111111111111111111111111");
    const anotherWallet = await call(gamePoints, "POST", { action: "verify-deposit", signature });
    assert.equal(anotherWallet.statusCode, 200);
    assert.equal(anotherWallet.payload.claimedPoints, "2500");
    assert.equal(scenario.rpcClaimCalls.length, 1);
});

test("a finalized transfer smaller than one point is not credited", async () => {
    scenario.transaction = makeDepositTransaction("1");
    const response = await call(gamePoints, "POST", { action: "verify-deposit", signature });

    assert.equal(response.statusCode, 422);
    assert.equal(response.payload.error, "cyfur_amount_too_small");
    assert.equal(scenario.rpcClaimCalls.length, 0);
});

test("a globally repeated transaction returns the current balance without crediting again", async () => {
    scenario.claimResult = { balance_points: "6821", already_claimed: true, amount_points: "2500" };

    const response = await call(gamePoints, "POST", { action: "verify-deposit", signature });

    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, "transaction_already_claimed");
    assert.equal(response.payload.balancePoints, "6821");
    assert.equal(scenario.rpcClaimCalls.length, 1);
});

test("verified-claims migration preserves balances and blocks legacy fabricated claims", async () => {
    const { readFileSync } = await import("node:fs");
    const migration = readFileSync(new URL("../supabase-game-points-verified-claims.sql", import.meta.url), "utf8");
    const pointsSchema = readFileSync(new URL("../supabase-game-points.sql", import.meta.url), "utf8");

    assert.match(pointsSchema, /floor\(100 \* power\(1\.08::numeric, p_level_number - 1\)\)/i);
    assert.match(pointsSchema, /when 3 then floor\(v_session\.entry_cost_points \* 1\.6\)/i);
    assert.match(pointsSchema, /when 2 then floor\(v_session\.entry_cost_points \* 0\.4\)/i);
    assert.match(pointsSchema, /primary key \(player_id, level_number\)/i);
    assert.match(pointsSchema, /on conflict \(player_id, level_number\) do nothing/i);
    assert.doesNotMatch(pointsSchema, /create or replace function public\.claim_game_points/i);
    assert.match(migration, /transaction_signature text primary key/i);
    assert.match(migration, /drop function if exists public\.claim_game_points/i);
    assert.match(migration, /create or replace function public\.claim_verified_game_points/i);
    assert.match(migration, /auth\.role\(\)[\s\S]*?'service_role'/i);
    assert.match(migration, /on conflict \(transaction_signature\) do nothing/i);
    assert.doesNotMatch(migration, /update public\.game_point_accounts[\s\S]*?set balance_points\s*=\s*0/i);
});

test("CYFUR deposit migration applies exact amounts without resetting balances or reusing deposits", () => {
    const migration = readFileSync(new URL("../supabase-game-points-cyfur-deposits.sql", import.meta.url), "utf8");

    assert.match(migration, /add column if not exists amount_raw numeric/i);
    assert.match(migration, /add column if not exists token_decimals integer/i);
    assert.match(migration, /floor\(p_amount_raw \* 1000 \/ power\(10::numeric, p_token_decimals\)\)/i);
    assert.match(migration, /'cyfur_deposit'/i);
    assert.match(migration, /pg_advisory_xact_lock/i);
    assert.match(migration, /prevent_reusing_game_point_deposit_signature/i);
    assert.match(migration, /credit_verified_cyfur_game_points/i);
    assert.match(migration, /auth\.role\(\)[\s\S]*?'service_role'/i);
    assert.doesNotMatch(migration, /update public\.game_point_accounts[\s\S]*?set balance_points\s*=\s*0/i);
    assert.doesNotMatch(migration, /delete from public\.game_point_accounts|truncate table public\.game_point_accounts/i);
});
