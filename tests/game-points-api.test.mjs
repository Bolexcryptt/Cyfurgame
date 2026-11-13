import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const gamePoints = require("../server/lib/game-points.js");
const levelEntry = require("../api/level-entry.js");
const levelCompletion = require("../api/level-completion.js");
const originalFetch = globalThis.fetch;
const originalEnvironment = { ...process.env };

function configureEnvironment() {
    process.env.SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    process.env.LEVELS_LOCKED = "false";
}

function restoreEnvironment() {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(process.env)) {
        if (!(name in originalEnvironment)) delete process.env[name];
    }
    Object.assign(process.env, originalEnvironment);
}

function makeResponse() {
    return {
        statusCode: 200,
        setHeader() {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
        }
    };
}

function mockWalletDatabase() {
    const calls = [];
    globalThis.fetch = async (input) => {
        const url = new URL(input);
        calls.push(url.pathname);
        if (url.pathname.endsWith("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000001" }));
        }
        if (url.pathname.includes("wallet_credit_accounts")) {
            return new Response(JSON.stringify([{ balance_credits: "2750" }]));
        }
        if (url.pathname.includes("game_point_level_completions")) {
            return new Response(JSON.stringify([{ level_number: 2 }]));
        }
        if (url.pathname.includes("level_completions")) {
            return new Response(JSON.stringify([{ level_number: 4 }]));
        }
        throw new Error(`Unexpected request: ${url}`);
    };
    return calls;
}

test("legacy game-points reads expose the canonical wallet and preserve prior clear history", async () => {
    configureEnvironment();
    const calls = mockWalletDatabase();
    try {
        const response = makeResponse();
        await gamePoints({
            method: "GET",
            headers: { authorization: "Bearer player-token" }
        }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.balanceCredits, "2750");
        assert.deepEqual(response.payload.completedLevels, [2, 4]);
        assert.equal(calls.some((path) => path.includes("game_point_accounts")), false);
    } finally {
        restoreEnvironment();
    }
});

test("legacy game-points route returns the same canonical wallet balance", async () => {
    configureEnvironment();
    mockWalletDatabase();
    try {
        const response = makeResponse();
        await levelEntry({
            method: "GET",
            url: "/api/level-entry?route=game-points",
            headers: { authorization: "Bearer player-token" }
        }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.balanceCredits, "2750");
        assert.deepEqual(response.payload.completedLevels, [2, 4]);
    } finally {
        restoreEnvironment();
    }
});

test("legacy point deposits and point-funded gameplay are retired instead of creating another balance", async () => {
    configureEnvironment();
    globalThis.fetch = async () => {
        return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000001" }));
    };
    try {
        const depositResponse = makeResponse();
        await gamePoints({
            method: "POST",
            headers: { authorization: "Bearer player-token" },
            body: { action: "verify-deposit" }
        }, depositResponse);
        assert.equal(depositResponse.statusCode, 410);

        const entryResponse = makeResponse();
        await levelEntry({
            method: "POST",
            url: "/api/level-entry",
            headers: { authorization: "Bearer player-token" },
            body: { gamePoints: true, levelNumber: 1 }
        }, entryResponse);
        assert.equal(entryResponse.statusCode, 410);

        const completionResponse = makeResponse();
        await levelCompletion({
            method: "POST",
            headers: { authorization: "Bearer player-token" },
            body: {
                gamePoints: true,
                sessionId: "123e4567-e89b-42d3-a456-426614174000",
                mirrors: [],
                launchDirection: 1
            }
        }, completionResponse);
        assert.equal(completionResponse.statusCode, 410);
    } finally {
        restoreEnvironment();
    }
});
