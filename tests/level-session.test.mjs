import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const levelSession = require("../api/level-session.js");
const originalFetch = globalThis.fetch;
const originalEnvironment = { ...process.env };
const playerId = "00000000-0000-4000-8000-000000000001";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";

function restoreEnvironment() {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
}

function createResponse() {
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

test("paid level timer starts through the authenticated server RPC", async (context) => {
    context.after(restoreEnvironment);
    process.env.LEVELS_LOCKED = "false";
    process.env.SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    const startedAt = "2026-11-15T09:00:00.000Z";
    let timerRequest;
    globalThis.fetch = async (input, options = {}) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: playerId }), { status: 200 });
        }
        if (url.pathname.endsWith("/rpc/start_wallet_level_timer")) {
            timerRequest = {
                authorization: options.headers.Authorization,
                body: JSON.parse(options.body)
            };
            return new Response(JSON.stringify(startedAt), { status: 200 });
        }
        throw new Error(`Unexpected timer request: ${url}`);
    };

    const response = createResponse();
    await levelSession({
        method: "POST",
        headers: { authorization: "Bearer player-token" },
        body: { sessionId }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload, { startedAt });
    assert.equal(timerRequest.authorization, "Bearer test-service-role-key");
    assert.deepEqual(timerRequest.body, { p_player_id: playerId, p_session_id: sessionId });
});

test("session timer migration restarts only a live, incomplete paid session", () => {
    const migration = readFileSync(new URL("../supabase-wallet-session-timer-fix.sql", import.meta.url), "utf8");
    assert.match(migration, /set timer_started_at = now\(\)/);
    assert.match(migration, /where id = p_session_id\s+and player_id = p_player_id\s+and completed_at is null\s+and expires_at > now\(\)/);
    assert.match(migration, /coalesce\(auth\.role\(\), ''\) <> 'service_role'/);
});
