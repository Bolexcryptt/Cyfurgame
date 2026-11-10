import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const diagnostics = require("../server/lib/withdrawal-diagnostics.js");
const solanaConfig = require("../server/lib/solana-deposit.js");
const savedFunctions = {
    getSupabaseWithdrawalConfig: diagnostics.getSupabaseWithdrawalConfig,
    getTreasuryDiagnosticSummary: diagnostics.getTreasuryDiagnosticSummary,
    verifyChainConfiguration: diagnostics.verifyChainConfiguration,
    verifyWithdrawalRpc: diagnostics.verifyWithdrawalRpc
};
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const diagnosticSecret = "test-diagnostic-secret";
const treasuryKeySentinel = "never-return-this-treasury-key";
let config;

diagnostics.getSupabaseWithdrawalConfig = async () => ({ connected: true, config });
diagnostics.getTreasuryDiagnosticSummary = () => ({
    present: true,
    valid: true,
    publicAddress: solanaConfig.RELICGRID_TREASURY_ADDRESS
});
diagnostics.verifyChainConfiguration = async () => ({
    available: true,
    healthCheckAvailable: true,
    health: "ok",
    rpcNetwork: "mainnet-beta",
    networkVerified: true,
    mintVerified: true,
    treasuryTokenAccountVerified: true,
    reason: null
});
diagnostics.verifyWithdrawalRpc = async () => ({ available: true });

const handler = require("../api/withdrawal-diagnostics.js");

function makeValidConfig(overrides = {}) {
    return {
        network: "mainnet-beta",
        official_mint_address: solanaConfig.RELICGRID_CYFUR_MINT_ADDRESS,
        treasury_address: solanaConfig.RELICGRID_TREASURY_ADDRESS,
        token_program_id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        token_decimals: 8,
        credits_per_token: 1000,
        rounding_policy: "floor",
        deposits_enabled: false,
        withdrawals_enabled: true,
        withdrawal_rate_limit_per_hour: 5,
        paid_gameplay_enabled: false,
        ...overrides
    };
}

async function getDiagnosticResponse() {
    const response = {
        statusCode: null,
        headers: {},
        payload: null,
        status(code) { this.statusCode = code; },
        setHeader(name, value) { this.headers[name] = value; },
        json(payload) { this.payload = payload; }
    };
    await handler({
        method: "GET",
        headers: { "x-diagnostic-key": diagnosticSecret }
    }, response);
    return response;
}

test.before(() => {
    process.env.WITHDRAWAL_DIAGNOSTIC_SECRET = diagnosticSecret;
    process.env.WITHDRAWAL_TREASURY_PRIVATE_KEY = treasuryKeySentinel;
    process.env.SOLANA_NETWORK = "mainnet-beta";
});

test.after(() => {
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
    Object.assign(diagnostics, savedFunctions);
});

test("withdrawal readiness requires both Vercel and Supabase withdrawal flags", async () => {
    config = makeValidConfig();
    process.env.WITHDRAWAL_ENABLED = "true";
    let response = await getDiagnosticResponse();
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.checks.vercelWithdrawalEnabled, true);
    assert.equal(response.payload.checks.supabaseWithdrawalsEnabled, true);
    assert.equal(response.payload.checks.withdrawalsEnabled, true);
    assert.equal(response.payload.checks.withdrawalRateLimitConfigured, true);
    assert.equal(response.payload.checks.withdrawalRateLimitPerHour, 5);
    assert.equal(response.payload.rpc.available, true);
    assert.equal(response.payload.rpc.healthCheckAvailable, true);
    assert.equal(response.payload.rpc.network, "mainnet-beta");
    assert.equal(response.payload.supabaseWithdrawalRpc.available, true);
    assert.equal(response.payload.ok, true);

    process.env.WITHDRAWAL_ENABLED = "false";
    response = await getDiagnosticResponse();
    assert.equal(response.payload.checks.vercelWithdrawalEnabled, false);
    assert.equal(response.payload.checks.supabaseWithdrawalsEnabled, true);
    assert.equal(response.payload.checks.withdrawalsEnabled, false);
    assert.equal(response.payload.ok, false);

    process.env.WITHDRAWAL_ENABLED = "true";
    config = makeValidConfig({ withdrawals_enabled: false });
    response = await getDiagnosticResponse();
    assert.equal(response.payload.checks.vercelWithdrawalEnabled, true);
    assert.equal(response.payload.checks.supabaseWithdrawalsEnabled, false);
    assert.equal(response.payload.checks.withdrawalsEnabled, false);
    assert.equal(response.payload.ok, false);

    config = makeValidConfig({ withdrawal_rate_limit_per_hour: null });
    response = await getDiagnosticResponse();
    assert.equal(response.payload.checks.withdrawalRateLimitConfigured, false);
    assert.equal(response.payload.ok, false);
});

test("diagnostic never returns treasury or diagnostic secrets", async () => {
    config = makeValidConfig();
    process.env.WITHDRAWAL_ENABLED = "true";

    const response = await getDiagnosticResponse();
    const serialized = JSON.stringify(response.payload);
    assert.equal(serialized.includes(treasuryKeySentinel), false);
    assert.equal(serialized.includes(diagnosticSecret), false);
});

test("Supabase diagnostic read requests the withdrawal flag", async () => {
    process.env.SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-sentinel";
    let requestUrl;
    globalThis.fetch = async (input) => {
        requestUrl = String(input);
        return new Response(JSON.stringify([{
            withdrawals_enabled: true,
            withdrawal_rate_limit_per_hour: 5
        }]), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });
    };

    const result = await savedFunctions.getSupabaseWithdrawalConfig();
    assert.equal(result.connected, true);
    assert.equal(result.config.withdrawals_enabled, true);
    assert.equal(result.config.withdrawal_rate_limit_per_hour, 5);
    assert.match(requestUrl, /select=[^&]*withdrawals_enabled[^&]*withdrawal_rate_limit_per_hour/);
    assert.equal(requestUrl.includes("service-role-sentinel"), false);
});
