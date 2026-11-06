import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import {
    requestAccountEmailLink,
    requestExistingAccountRecovery,
    hydratePlayerFromAuthenticatedAccount,
    restoreOrCreatePlayerSession,
    verifyAccountEmailLink,
    verifyExistingAccountRecovery
} from "../player-auth.mjs";

const require = createRequire(import.meta.url);
const walletHandler = require("../api/wallet.js");
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const playerId = "00000000-0000-4000-8000-000000000001";

function resetEnvironment() {
    process.env.SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
}

function createResponse() {
    return {
        statusCode: 200,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        json(payload) {
            this.payload = payload;
            return this;
        }
    };
}

function installRecoveryFetch({ user = { id: playerId, is_anonymous: true }, records = {}, failTable = null } = {}) {
    const requestedTables = [];
    globalThis.fetch = async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/auth/v1/user")) {
            return new Response(JSON.stringify(user), { status: 200 });
        }
        const table = url.pathname.split("/").pop();
        requestedTables.push(table);
        if (table === failTable) {
            return new Response(JSON.stringify({ code: "PGRST301" }), { status: 403 });
        }
        return new Response(JSON.stringify(records[table] || []), { status: 200 });
    };
    return requestedTables;
}

async function callRecoveryPreflight(url = "/api/wallet?action=identity-recovery-preflight") {
    const response = createResponse();
    await walletHandler({
        method: "GET",
        url,
        headers: { authorization: "Bearer player-session" }
    }, response);
    return response;
}

test("saved Supabase sessions are verified and reused instead of creating another player", async () => {
    let anonymousSignIns = 0;
    const auth = {
        async getSession() {
            return { data: { session: { user: { id: playerId } } }, error: null };
        },
        async getUser() {
            return { data: { user: { id: playerId, is_anonymous: true } }, error: null };
        },
        async signInAnonymously() {
            anonymousSignIns += 1;
            return { data: { user: { id: "new-player" } }, error: null };
        }
    };

    const result = await restoreOrCreatePlayerSession(auth);

    assert.equal(result.user.id, playerId);
    assert.equal(result.createdAnonymously, false);
    assert.equal(anonymousSignIns, 0);
});

test("a new player gets one anonymous identity only when no session exists", async () => {
    let anonymousSignIns = 0;
    const auth = {
        async getSession() {
            return { data: { session: null }, error: null };
        },
        async signInAnonymously() {
            anonymousSignIns += 1;
            return { data: { user: { id: playerId, is_anonymous: true } }, error: null };
        }
    };

    const result = await restoreOrCreatePlayerSession(auth);

    assert.equal(result.user.id, playerId);
    assert.equal(result.createdAnonymously, true);
    assert.equal(anonymousSignIns, 1);
});

test("authenticated account hydration uses server progress and ignores another local identity", () => {
    const hydrated = hydratePlayerFromAuthenticatedAccount({
        name: "Old callsign",
        playerId: "different-local-identity",
        completedLevels: [1, 2, 3],
        unlockedLevel: 4,
        lastLevel: 9,
        transitionMilestonesPlayed: [7],
        tutorialSeen: true,
        watchedGameIntro: true
    }, {
        id: playerId,
        is_anonymous: false
    }, {
        display_name: "Server Pilot"
    }, [2, 1, 2, 200]);

    assert.equal(hydrated.playerId, playerId);
    assert.equal(hydrated.name, "Server Pilot");
    assert.deepEqual(hydrated.completedLevels, [1, 2]);
    assert.equal(hydrated.unlockedLevel, 3);
    assert.equal(hydrated.lastLevel, 3);
    assert.deepEqual(hydrated.transitionMilestonesPlayed, []);
    assert.equal(hydrated.tutorialSeen, true);
    assert.equal(hydrated.watchedGameIntro, true);
});

test("same authenticated account keeps local-only settings but server progress stays authoritative", () => {
    const hydrated = hydratePlayerFromAuthenticatedAccount({
        name: "Local callsign",
        playerId,
        completedLevels: [1, 2, 3],
        unlockedLevel: 4,
        lastLevel: 6,
        transitionMilestonesPlayed: [7],
        tutorialSeen: true
    }, {
        id: playerId,
        is_anonymous: true
    }, {
        display_name: ""
    }, [1, 4]);

    assert.equal(hydrated.name, "Local callsign");
    assert.deepEqual(hydrated.completedLevels, [1, 4]);
    assert.equal(hydrated.unlockedLevel, 2);
    assert.equal(hydrated.lastLevel, 6);
    assert.deepEqual(hydrated.transitionMilestonesPlayed, [7]);
    assert.equal(hydrated.tutorialSeen, true);
});

test("an invalid saved session fails closed instead of silently creating another player", async () => {
    let anonymousSignIns = 0;
    const auth = {
        async getSession() {
            return { data: { session: { user: { id: playerId } } }, error: null };
        },
        async getUser() {
            return { data: { user: null }, error: new Error("session verification failed") };
        },
        async signInAnonymously() {
            anonymousSignIns += 1;
            return { data: { user: { id: "new-player" } }, error: null };
        }
    };

    await assert.rejects(() => restoreOrCreatePlayerSession(auth), /session verification failed/);
    assert.equal(anonymousSignIns, 0);
});

test("email upgrade keeps the current anonymous identity and verifies an email-change OTP", async () => {
    const calls = [];
    const auth = {
        async updateUser(attributes) {
            calls.push(["updateUser", attributes]);
            return { data: { user: { id: playerId } }, error: null };
        },
        async verifyOtp(attributes) {
            calls.push(["verifyOtp", attributes]);
            return { data: { user: { id: playerId, is_anonymous: false } }, error: null };
        }
    };

    await requestAccountEmailLink(auth, " Player@Example.com ");
    const verified = await verifyAccountEmailLink(auth, "PLAYER@example.com", "123456");

    assert.deepEqual(calls, [
        ["updateUser", { email: "player@example.com" }],
        ["verifyOtp", {
            email: "player@example.com",
            token: "123456",
            type: "email_change"
        }]
    ]);
    assert.equal(verified.id, playerId);
});

test("account recovery never creates a new permanent user and verifies the email OTP", async () => {
    const calls = [];
    const auth = {
        async signInWithOtp(attributes) {
            calls.push(["signInWithOtp", attributes]);
            return { data: {}, error: null };
        },
        async verifyOtp(attributes) {
            calls.push(["verifyOtp", attributes]);
            return { data: { user: { id: playerId, is_anonymous: false } }, error: null };
        }
    };

    await requestExistingAccountRecovery(auth, "player@example.com");
    const recovered = await verifyExistingAccountRecovery(auth, "player@example.com", "654321");

    assert.deepEqual(calls, [
        ["signInWithOtp", {
            email: "player@example.com",
            options: { shouldCreateUser: false }
        }],
        ["verifyOtp", {
            email: "player@example.com",
            token: "654321",
            type: "email"
        }]
    ]);
    assert.equal(recovered.id, playerId);
});

test("account identity recovery is read-only and allowed only for a data-free anonymous player", async (t) => {
    resetEnvironment();
    t.after(() => {
        globalThis.fetch = originalFetch;
        for (const [name, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    const requestedTables = installRecoveryFetch({
        records: {
            player_profiles: [{ id: playerId, display_name: "" }],
            wallet_credit_accounts: [{ balance_credits: "0" }]
        }
    });
    const response = await callRecoveryPreflight();

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.safeToRecover, true);
    assert.equal(response.payload.reason, null);
    assert.equal(requestedTables.length, 11);
});

test("account identity recovery refuses to switch away from existing player data", async (t) => {
    resetEnvironment();
    t.after(() => {
        globalThis.fetch = originalFetch;
        for (const [name, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    installRecoveryFetch({
        records: {
            player_profiles: [{ id: playerId, display_name: "" }],
            wallet_credit_accounts: [{ balance_credits: "0" }],
            wallet_credit_ledger: [{ id: "ledger-entry" }]
        }
    });
    const response = await callRecoveryPreflight();

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.safeToRecover, false);
    assert.equal(response.payload.reason, "current_identity_has_data");
});

test("account identity recovery rejects permanent users and database failures", async (t) => {
    resetEnvironment();
    t.after(() => {
        globalThis.fetch = originalFetch;
        for (const [name, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    const permanentUserTables = installRecoveryFetch({
        user: { id: playerId, is_anonymous: false }
    });
    const permanentResponse = await callRecoveryPreflight();
    assert.equal(permanentResponse.statusCode, 409);
    assert.equal(permanentUserTables.length, 0);

    installRecoveryFetch({ failTable: "wallet_credit_ledger" });
    const failedResponse = await callRecoveryPreflight();
    assert.equal(failedResponse.statusCode, 502);
    assert.equal(failedResponse.payload.safeToRecover, undefined);
});

test("player records remain keyed to auth user IDs and web sessions persist", () => {
    const authSchema = readFileSync(new URL("../supabase-leaderboard.sql", import.meta.url), "utf8");
    const walletSchema = readFileSync(new URL("../supabase-wallet.sql", import.meta.url), "utf8");
    const withdrawalSchema = readFileSync(new URL("../supabase-wallet-withdrawals.sql", import.meta.url), "utf8");
    const client = readFileSync(new URL("../supabase.js", import.meta.url), "utf8");

    assert.match(authSchema, /id uuid primary key references auth\.users \(id\) on delete cascade/i);
    assert.match(authSchema, /after insert on auth\.users/i);
    assert.match(walletSchema, /player_id uuid primary key references public\.player_profiles \(id\) on delete cascade/i);
    assert.match(withdrawalSchema, /player_id uuid not null references public\.player_profiles \(id\) on delete cascade/i);
    assert.match(client, /persistSession:\s*true/);
});

test("the withdrawal UI exposes and wires explicit signed receiving-wallet verification", () => {
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /id="wallet-link-button"[^>]*>LINK RECEIVING WALLET/);
    assert.match(html, /id="withdrawal-link-status"/);
    assert.match(app, /getElementById\("wallet-link-button"\)\?\.addEventListener\("click",\s*\(\) => \{\s*void connectSolanaWallet\(\)/);
    assert.match(app, /action:\s*"challenge",\s*walletAddress/);
    assert.match(app, /action:\s*"verify",\s*walletAddress,\s*signature/);
    assert.match(app, /await refreshWithdrawalStatus\(\)/);
});
