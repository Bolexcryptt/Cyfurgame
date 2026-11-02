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

test("the campaign remains open even when a stale pause variable is configured", () => {
    assert.equal(areLevelsGloballyLocked({}), false);
    assert.equal(areLevelsGloballyLocked({ LEVELS_LOCKED: "true" }), false);
    assert.equal(areLevelsGloballyLocked({ LEVELS_LOCKED: "0" }), false);
    assert.equal(areLevelsGloballyLocked({ LEVELS_LOCKED: "False" }), false);
    assert.equal(areLevelsGloballyLocked({ LEVELS_LOCKED: "false" }), false);
});

test("game configuration always reports the campaign open without caching", (context) => {
    context.after(restoreEnvironment);
    delete process.env.LEVELS_LOCKED;

    const request = { method: "GET", headers: {} };
    const openResponse = createResponse();
    gameConfig(request, openResponse);
    assert.equal(openResponse.statusCode, 200);
    assert.deepEqual(openResponse.payload, { levelsLocked: false });
    assert.equal(openResponse.headers["Cache-Control"], "no-store");

    process.env.LEVELS_LOCKED = "true";
    const lockedResponse = createResponse();
    gameConfig(request, lockedResponse);
    assert.deepEqual(lockedResponse.payload, { levelsLocked: false });
});

test("level-entry and gameplay APIs ignore a stale global lock setting", async (context) => {
    context.after(restoreEnvironment);
    process.env.LEVELS_LOCKED = "true";

    for (const handler of handlers) {
        const response = createResponse();
        await handler({ method: "POST", headers: {}, body: {} }, response);
        assert.notEqual(response.statusCode, 423);
        assert.notEqual(response.payload?.error, "levels_locked");
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
