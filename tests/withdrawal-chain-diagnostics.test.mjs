import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
    deriveAssociatedTokenAccount,
    GENESIS_HASHES,
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS
} = require("../server/lib/solana-deposit.js");
const {
    verifyChainConfiguration,
    verifyWithdrawalRpc
} = require("../server/lib/withdrawal-diagnostics.js");
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function makeConfig(overrides = {}) {
    return {
        network: "mainnet-beta",
        official_mint_address: RELICGRID_CYFUR_MINT_ADDRESS,
        treasury_address: RELICGRID_TREASURY_ADDRESS,
        token_program_id: tokenProgram,
        token_decimals: 8,
        ...overrides
    };
}

function accountResponse({ owner, type, info }) {
    return {
        context: { slot: 1 },
        value: {
            owner,
            data: {
                program: "spl-token",
                parsed: { type, info }
            }
        }
    };
}

function installRpcMock({
    health = "ok",
    genesisHash = GENESIS_HASHES["mainnet-beta"],
    mintOverride,
    treasuryOverride
} = {}) {
    const calls = [];
    globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        calls.push(request.method);
        let result;
        if (request.method === "getHealth") {
            result = health;
        } else if (request.method === "getGenesisHash") {
            result = genesisHash;
        } else if (request.method === "getAccountInfo" && request.params[0] === RELICGRID_CYFUR_MINT_ADDRESS) {
            result = mintOverride ?? accountResponse({
                owner: tokenProgram,
                type: "mint",
                info: { decimals: 8, mintAuthority: null, freezeAuthority: null }
            });
        } else if (request.method === "getAccountInfo") {
            result = treasuryOverride ?? accountResponse({
                owner: tokenProgram,
                type: "account",
                info: {
                    mint: RELICGRID_CYFUR_MINT_ADDRESS,
                    owner: RELICGRID_TREASURY_ADDRESS,
                    tokenAmount: { amount: "100000000", decimals: 8, uiAmount: 1 }
                }
            });
        } else {
            throw new Error(`Unexpected RPC method: ${request.method}`);
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });
    };
    return calls;
}

test.beforeEach(() => {
    process.env.SOLANA_NETWORK = "mainnet-beta";
    process.env.SOLANA_RPC_URL = "https://rpc.example/mainnet?api-key=secret-sentinel";
});

test.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
});

test("chain diagnostics verify mainnet, official mint, and treasury ATA without returning the RPC URL", async () => {
    const calls = installRpcMock();
    const result = await verifyChainConfiguration(makeConfig());

    assert.deepEqual(calls, ["getHealth", "getGenesisHash", "getAccountInfo", "getAccountInfo"]);
    assert.equal(result.available, true);
    assert.equal(result.healthCheckAvailable, true);
    assert.equal(result.health, "ok");
    assert.equal(result.configured, true);
    assert.equal(result.environmentNetwork, "mainnet-beta");
    assert.equal(result.configNetwork, "mainnet-beta");
    assert.equal(result.rpcNetwork, "mainnet-beta");
    assert.equal(result.networkVerified, true);
    assert.equal(result.mintVerified, true);
    assert.equal(result.treasuryTokenAccountVerified, true);
    assert.equal(JSON.stringify(result).includes("secret-sentinel"), false);
    assert.equal(JSON.stringify(result).includes("rpc.example"), false);
    assert.equal(
        deriveAssociatedTokenAccount(RELICGRID_TREASURY_ADDRESS, RELICGRID_CYFUR_MINT_ADDRESS, tokenProgram).length > 0,
        true
    );
});

test("chain diagnostics report environment and RPC network mismatches separately", async () => {
    const calls = installRpcMock({ genesisHash: GENESIS_HASHES.devnet });
    process.env.SOLANA_NETWORK = "devnet";
    const result = await verifyChainConfiguration(makeConfig());

    assert.deepEqual(calls, ["getHealth", "getGenesisHash"]);
    assert.equal(result.available, true);
    assert.equal(result.rpcNetwork, "devnet");
    assert.equal(result.environmentNetwork, "devnet");
    assert.equal(result.configNetwork, "mainnet-beta");
    assert.equal(result.networkVerified, false);
    assert.match(result.reason, /RPC network is devnet.*SOLANA_NETWORK is devnet.*Supabase network is mainnet-beta/);
});

test("chain diagnostics stop when getHealth reports an unhealthy provider", async () => {
    const calls = installRpcMock({ health: "behind" });
    const result = await verifyChainConfiguration(makeConfig());

    assert.deepEqual(calls, ["getHealth"]);
    assert.equal(result.available, false);
    assert.equal(result.healthCheckAvailable, false);
    assert.equal(result.health, "behind");
    assert.match(result.reason, /getHealth returned "behind"/);
});

test("chain diagnostics identify missing RPC configuration without exposing credentials", async () => {
    delete process.env.SOLANA_RPC_URL;
    const result = await verifyChainConfiguration(makeConfig());

    assert.equal(result.available, false);
    assert.equal(result.configured, false);
    assert.match(result.reason, /SOLANA_RPC_URL is not configured/);
    assert.equal(JSON.stringify(result).includes("secret-sentinel"), false);
});

test("chain diagnostics separate an invalid mint from an RPC network failure", async () => {
    installRpcMock({
        mintOverride: accountResponse({
            owner: "11111111111111111111111111111111",
            type: "mint",
            info: { decimals: 8, mintAuthority: null, freezeAuthority: null }
        })
    });
    const result = await verifyChainConfiguration(makeConfig());

    assert.equal(result.networkVerified, true);
    assert.equal(result.mintVerified, false);
    assert.equal(result.treasuryTokenAccountVerified, true);
    assert.match(result.reason, /does not verify the configured CYFUR mint/);
});

test("chain diagnostics explain RPC transport failure without exposing the configured URL", async () => {
    globalThis.fetch = async () => {
        throw new Error("Request failed for https://rpc.example/mainnet?api-key=secret-sentinel");
    };
    const result = await verifyChainConfiguration(makeConfig());

    assert.equal(result.available, false);
    assert.match(result.reason, /Could not connect to the configured Solana RPC/);
    assert.equal(JSON.stringify(result).includes("secret-sentinel"), false);
    assert.equal(JSON.stringify(result).includes("rpc.example"), false);
});

test("chain diagnostics classify authentication, endpoint, timeout, and provider failures", async () => {
    const cases = [
        {
            name: "authentication",
            fetch: async () => new Response("denied", { status: 401 }),
            reason: /authentication was rejected/,
            httpStatus: 401
        },
        {
            name: "invalid endpoint",
            fetch: async () => new Response("missing", { status: 404 }),
            reason: /SOLANA_RPC_URL path is invalid/,
            httpStatus: 404
        },
        {
            name: "provider error",
            fetch: async () => new Response("unavailable", { status: 503 }),
            reason: /provider returned HTTP 503/,
            httpStatus: 503
        },
        {
            name: "timeout",
            fetch: async () => {
                const error = new Error("Request timed out");
                error.cause = { code: "ETIMEDOUT" };
                throw error;
            },
            reason: /request timed out/
        }
    ];

    for (const entry of cases) {
        globalThis.fetch = entry.fetch;
        const result = await verifyChainConfiguration(makeConfig());
        assert.match(result.reason, entry.reason, entry.name);
        assert.equal(result.rpcHttpStatus ?? null, entry.httpStatus ?? null, entry.name);
        assert.equal(JSON.stringify(result).includes("secret-sentinel"), false, entry.name);
        assert.equal(JSON.stringify(result).includes("rpc.example"), false, entry.name);
    }
});

test("Supabase RPC diagnostics distinguish missing migration, denied access, and valid guard rejection", async () => {
    process.env.SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret-sentinel";
    const responses = [
        {
            status: 400,
            body: { code: "22023", message: "Invalid withdrawal reservation." },
            available: true,
            reason: /expected invalid-input guard rejected/
        },
        {
            status: 404,
            body: { code: "PGRST202", message: "Function not found" },
            available: false,
            reason: /withdrawal RPC was not found.*migration/
        },
        {
            status: 403,
            body: { code: "42501", message: `Denied ${"service-role-secret-sentinel"}` },
            available: false,
            reason: /rejected the withdrawal RPC authorization/
        }
    ];

    for (const entry of responses) {
        globalThis.fetch = async (_url, options) => {
            assert.equal(options.headers.apikey, "service-role-secret-sentinel");
            return new Response(JSON.stringify(entry.body), {
                status: entry.status,
                headers: { "Content-Type": "application/json" }
            });
        };
        const result = await verifyWithdrawalRpc();
        assert.equal(result.available, entry.available);
        assert.match(result.reason, entry.reason);
        assert.equal(JSON.stringify(result).includes("service-role-secret-sentinel"), false);
    }
});
