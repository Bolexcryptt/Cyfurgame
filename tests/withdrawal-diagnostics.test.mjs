import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { Keypair } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const { getTreasuryDiagnosticSummary, parseTreasurySecret } = require("../server/lib/withdrawal-diagnostics.js");

const originalSecret = process.env.WITHDRAWAL_TREASURY_PRIVATE_KEY;
const originalFallback = process.env.TREASURY_PRIVATE_KEY;

function restoreEnv() {
    if (originalSecret === undefined) delete process.env.WITHDRAWAL_TREASURY_PRIVATE_KEY;
    else process.env.WITHDRAWAL_TREASURY_PRIVATE_KEY = originalSecret;

    if (originalFallback === undefined) delete process.env.TREASURY_PRIVATE_KEY;
    else process.env.TREASURY_PRIVATE_KEY = originalFallback;
}

test("parses a valid Solana private key and derives the public address without exposing the secret", () => {
    const keypair = Keypair.generate();
    process.env.WITHDRAWAL_TREASURY_PRIVATE_KEY = Buffer.from(keypair.secretKey).toString("base64");

    const secretBytes = parseTreasurySecret(process.env.WITHDRAWAL_TREASURY_PRIVATE_KEY);
    const summary = getTreasuryDiagnosticSummary();

    assert.ok(secretBytes && secretBytes.length === 64, "The secret key should decode to the correct 64-byte length.");
    assert.equal(summary.valid, true, "The key should validate successfully.");
    assert.equal(summary.publicAddress, keypair.publicKey.toBase58(), "The public address should match the loaded keypair.");

    restoreEnv();
});

test("reports a missing or invalid treasury secret without leaking it", () => {
    delete process.env.WITHDRAWAL_TREASURY_PRIVATE_KEY;
    delete process.env.TREASURY_PRIVATE_KEY;

    const summary = getTreasuryDiagnosticSummary();

    assert.equal(summary.present, false);
    assert.equal(summary.valid, false);
    assert.match(summary.reason, /not set/i);

    restoreEnv();
});
