import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
    calculateCreditsFromTokenAmountRaw,
    calculateWithdrawalTokenAmountRaw,
    executeCyfurWithdrawal,
    parseWithdrawalSecret
} = require("../server/lib/withdrawals.js");
const { Keypair } = require("@solana/web3.js");
const { RELICGRID_CYFUR_MINT_ADDRESS, RELICGRID_TREASURY_ADDRESS } = require("../server/lib/solana-deposit.js");

test("withdrawal conversion keeps the documented CYFUR credit rate and integer math", () => {
    assert.equal(calculateWithdrawalTokenAmountRaw("10000", 8), "100000000");
    assert.equal(calculateWithdrawalTokenAmountRaw("1", 8), "10000");
    assert.equal(calculateCreditsFromTokenAmountRaw("100000000", 8), "10000");
    assert.equal(calculateCreditsFromTokenAmountRaw("10000", 8), "1");
});

test("withdrawal validation rejects invalid or non-convertible amounts", () => {
    assert.throws(() => calculateWithdrawalTokenAmountRaw("0", 8), /greater than zero/i);
    assert.throws(() => calculateWithdrawalTokenAmountRaw("1", -1), /decimals/i);
    assert.throws(() => calculateCreditsFromTokenAmountRaw("0", 8), /greater than zero/i);
    assert.throws(() => calculateWithdrawalTokenAmountRaw("abc", 8), /positive integer string/i);
});

test("withdrawal signer parser accepts base64 and JSON-array secret formats", () => {
    const keypair = Keypair.generate();

    assert.deepEqual(
        parseWithdrawalSecret(Buffer.from(keypair.secretKey).toString("base64")),
        Buffer.from(keypair.secretKey)
    );
    assert.deepEqual(
        parseWithdrawalSecret(JSON.stringify(Array.from(keypair.secretKey))),
        Buffer.from(keypair.secretKey)
    );
});

test("withdrawal refuses a signer that does not derive to the configured treasury", async () => {
    const incorrectSigner = Keypair.generate();
    const player = Keypair.generate();

    await assert.rejects(
        executeCyfurWithdrawal({
            rpcUrl: "https://invalid.example",
            playerWalletAddress: player.publicKey.toBase58(),
            treasuryAddress: RELICGRID_TREASURY_ADDRESS,
            mintAddress: RELICGRID_CYFUR_MINT_ADDRESS,
            amountRaw: "1",
            treasurySigner: incorrectSigner
        }),
        /signer does not match/i
    );
});
