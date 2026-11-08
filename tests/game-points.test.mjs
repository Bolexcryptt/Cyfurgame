import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { evaluateLevelStars, getLevelEconomy, levels } from "../levels.js";

const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
const environmentNames = [
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "LEVELS_LOCKED"
];
const previousEnvironment = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]])
);

function configureEnvironment() {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    process.env.LEVELS_LOCKED = "false";
}

function restoreEnvironment() {
    globalThis.fetch = originalFetch;
    for (const name of environmentNames) {
        if (previousEnvironment[name] === undefined) delete process.env[name];
        else process.env[name] = previousEnvironment[name];
    }
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

function authenticatedRequest(body = {}, method = "POST") {
    return {
        method,
        headers: { authorization: "Bearer test-session-token" },
        body
    };
}

function mockUserResponse(url) {
    if (String(url).includes("/auth/v1/user")) {
        return new Response(JSON.stringify({ id: "123e4567-e89b-42d3-a456-426614174000" }), {
            status: 200
        });
    }
    return null;
}

test("server game-point claims and level entries use their isolated RPCs", async (context) => {
    context.after(restoreEnvironment);
    configureEnvironment();
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        const userResponse = mockUserResponse(target);
        if (userResponse) return userResponse;
        if (target.includes("/game_point_accounts?")) {
            return new Response(JSON.stringify([{ balance_points: "1000" }]), { status: 200 });
        }
        if (target.includes("/rpc/claim_game_points")) {
            calls.push(["claim", JSON.parse(options.body)]);
            return new Response(JSON.stringify([{
                balance_points: "1000",
                already_claimed: false
            }]), { status: 200 });
        }
        if (target.includes("/rpc/start_game_point_level")) {
            calls.push(["start", JSON.parse(options.body)]);
            return new Response(JSON.stringify([{
                session_id: "223e4567-e89b-42d3-a456-426614174000",
                balance_points: "900",
                entry_cost_points: "100"
            }]), { status: 200 });
        }
        throw new Error(`Unexpected game-points request: ${target}`);
    };

    const endpoint = require("../api/game-points.js");
    const status = makeResponse();
    await endpoint(authenticatedRequest({}, "GET"), status);
    assert.equal(status.statusCode, 200);
    assert.equal(status.payload.balancePoints, "1000");
    assert.equal(status.payload.balanceVerified, true);

    const claim = makeResponse();
    await endpoint(authenticatedRequest({
        action: "claim",
        signature: "1".repeat(88)
    }), claim);
    assert.equal(claim.statusCode, 200);
    assert.equal(claim.payload.pointsAdded, "1000");
    assert.equal(claim.payload.balancePoints, "1000");

    const entry = makeResponse();
    await endpoint(authenticatedRequest({
        action: "start",
        levelNumber: 1,
        requestId: "323e4567-e89b-42d3-a456-426614174000"
    }), entry);
    assert.equal(entry.statusCode, 200);
    assert.equal(entry.payload.gamePoints, true);
    assert.equal(entry.payload.entryCostPoints, "100");
    assert.equal(entry.payload.balancePoints, "900");
    assert.deepEqual(calls.map(([action]) => action), ["claim", "start"]);
    assert.equal(calls[0][1].p_player_id, "123e4567-e89b-42d3-a456-426614174000");
    assert.equal(calls[1][1].p_level_number, 1);
});

test("server completion pays all three star tiers from server time and rejects failed proofs", async (context) => {
    context.after(restoreEnvironment);
    configureEnvironment();
    const endpoint = require("../api/level-completion.js");
    const level = levels[0];
    const mirrors = level.solutionMirrors.map(({ row, col, orientation }) => ({
        row,
        col,
        slash: orientation === "/"
    }));
    const rpcCalls = [];
    let elapsedMilliseconds = 0;
    let completedAt = null;
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        const userResponse = mockUserResponse(target);
        if (userResponse) return userResponse;
        if (target.includes("/game_point_level_sessions?")) {
            return new Response(JSON.stringify([{
                id: "123e4567-e89b-42d3-a456-426614174000",
                player_id: "123e4567-e89b-42d3-a456-426614174000",
                level_number: 1,
                timer_started_at: new Date(Date.now() - elapsedMilliseconds).toISOString(),
                expires_at: new Date(Date.now() + 60_000).toISOString(),
                completed_at: completedAt
            }]), { status: 200 });
        }
        if (target.includes("/rpc/complete_game_point_level")) {
            const payload = JSON.parse(options.body);
            rpcCalls.push(payload);
            return new Response(JSON.stringify([{
                balance_points: completedAt
                    ? "1060"
                    : String(900 + payload.p_reward_points),
                stars: completedAt ? 3 : payload.p_stars,
                reward_points: completedAt ? 160 : payload.p_reward_points,
                elapsed_milliseconds: completedAt ? 1000 : payload.p_elapsed_milliseconds,
                already_completed: completedAt !== null
            }]), { status: 200 });
        }
        throw new Error(`Unexpected completion request: ${target}`);
    };

    const scenarios = [
        {
            stars: 3,
            elapsed: 1_000,
            reward: getLevelEconomy(1).threeStarPayoutCredits
        },
        {
            stars: 2,
            elapsed: Math.ceil(
                (level.starTimeTargets.threeSeconds + level.starTimeTargets.twoSeconds) * 500
            ),
            reward: getLevelEconomy(1).twoStarRefundCredits
        },
        {
            stars: 1,
            elapsed: Math.ceil(level.starTimeTargets.twoSeconds * 1000) + 1_000,
            reward: 0
        }
    ];

    for (const scenario of scenarios) {
        elapsedMilliseconds = scenario.elapsed;
        completedAt = null;
        const response = makeResponse();
        await endpoint(authenticatedRequest({
            sessionId: "123e4567-e89b-42d3-a456-426614174000",
            mirrors,
            launchDirection: level.start.direction,
            gamePoints: true
        }), response);
        const expected = evaluateLevelStars(level, scenario.elapsed);
        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.stars, scenario.stars);
        assert.equal(expected.stars, scenario.stars);
        assert.equal(response.payload.rewardPoints, String(scenario.reward));
        assert.equal(rpcCalls.at(-1).p_stars, scenario.stars);
        assert.equal(rpcCalls.at(-1).p_reward_points, scenario.reward);
    }

    elapsedMilliseconds = 1_000;
    const failed = makeResponse();
    await endpoint(authenticatedRequest({
        sessionId: "123e4567-e89b-42d3-a456-426614174000",
        mirrors: [],
        launchDirection: level.start.direction,
        gamePoints: true
    }), failed);
    assert.equal(failed.statusCode, 422);
    assert.equal(failed.payload.error, "battery_not_connected");
    assert.equal(rpcCalls.length, 3);

    completedAt = new Date().toISOString();
    const duplicate = makeResponse();
    await endpoint(authenticatedRequest({
        sessionId: "123e4567-e89b-42d3-a456-426614174000",
        mirrors,
        launchDirection: level.start.direction,
        gamePoints: true
    }), duplicate);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.payload.duplicate, true);
    assert.equal(duplicate.payload.rewardPoints, "160");
    assert.equal(duplicate.payload.balancePoints, "1060");
    assert.equal(rpcCalls.at(-1).p_reward_points, 0);
});

test("game-point migration keeps the balance non-withdrawable and completion idempotent", () => {
    const migration = readFileSync(new URL("../supabase-game-points.sql", import.meta.url), "utf8");
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    assert.match(migration, /create table if not exists public\.game_point_accounts/);
    assert.match(migration, /create table if not exists public\.game_point_ledger/);
    assert.match(migration, /create table if not exists public\.game_point_level_sessions/);
    assert.match(migration, /primary key \(player_id, level_number\)/);
    assert.match(migration, /when 3 then floor\(v_session\.entry_cost_points \* 1\.6\)::bigint/);
    assert.match(migration, /when 2 then floor\(v_session\.entry_cost_points \* 0\.4\)::bigint/);
    assert.match(migration, /on conflict \(idempotency_key\) do nothing/);
    assert.match(migration, /on conflict \(player_id, level_number\) do nothing/);
    assert.match(migration, /Entry request ID was already used for another level/);
    assert.match(migration, /revoke all on function public\.complete_game_point_level/);
    assert.doesNotMatch(migration, /wallet_credit_accounts|wallet_credit_ledger|public\.level_completions/);
    assert.match(app, /const displayedRewardAmount = result\.duplicate \? "0" : rewardAmount/);
});
