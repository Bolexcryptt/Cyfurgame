import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { areLevelsGloballyLocked } = require("../server/lib/level-lock.js");
const gameConfig = require("../api/game-config.js");
const levelEntry = require("../api/level-entry.js");
const levelSession = require("../api/level-session.js");
const levelCompletion = require("../api/level-completion.js");
const handlers = [levelEntry, levelSession, levelCompletion];
const originalEnvironment = { ...process.env };

function restoreEnvironment() {
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
}

function createResponse() {
    return {
        headers: {},
        statusCode: 200,
        payload: undefined,
        setHeader(name, value) {
            this.headers[name] = value;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        }
    };
}

test("the global lock defaults to locked and only exact false unlocks it", () => {
    assert.equal(areLevelsGloballyLocked({}), true);
    assert.equal(areLevelsGloballyLocked({ LEVELS_LOCKED: "true" }), true);
    assert.equal(areLevelsGloballyLocked({ LEVELS_LOCKED: "0" }), true);
    assert.equal(areLevelsGloballyLocked({ LEVELS_LOCKED: "False" }), true);
    assert.equal(areLevelsGloballyLocked({ LEVELS_LOCKED: "false" }), false);
});

test("game configuration returns the runtime lock state without caching", (context) => {
    context.after(restoreEnvironment);
    delete process.env.LEVELS_LOCKED;

    const request = { method: "GET", headers: {} };
    const lockedResponse = createResponse();
    gameConfig(request, lockedResponse);
    assert.equal(lockedResponse.statusCode, 200);
    assert.deepEqual(lockedResponse.payload, { levelsLocked: true });
    assert.equal(lockedResponse.headers["Cache-Control"], "no-store");

    process.env.LEVELS_LOCKED = "false";
    const unlockedResponse = createResponse();
    gameConfig(request, unlockedResponse);
    assert.deepEqual(unlockedResponse.payload, { levelsLocked: false });
});

test("all level-entry and gameplay APIs reject requests while the global lock is active", async (context) => {
    context.after(restoreEnvironment);
    process.env.LEVELS_LOCKED = "true";

    for (const handler of handlers) {
        const response = createResponse();
        await handler({ method: "POST", headers: {}, body: {} }, response);
        assert.equal(response.statusCode, 423);
        assert.deepEqual(response.payload, {
            error: "levels_locked",
            levelsLocked: true
        });
    }
});

test("setting LEVELS_LOCKED=false removes the global lock from each API route", async (context) => {
    context.after(restoreEnvironment);
    process.env.LEVELS_LOCKED = "false";
    process.env.SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

    for (const handler of handlers) {
        const response = createResponse();
        await handler({ method: "POST", headers: {}, body: {} }, response);
        assert.equal(response.statusCode, 401);
        assert.notEqual(response.payload?.error, "levels_locked");
    }
});
