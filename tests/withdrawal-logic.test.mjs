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
const originalSolanaNetwork = process.env.SOLANA_NETWORK;

test.before(() => {
    process.env.SOLANA_NETWORK = "mainnet-beta";
});

test.after(() => {
    if (originalSolanaNetwork === undefined) delete process.env.SOLANA_NETWORK;
    else process.env.SOLANA_NETWORK = originalSolanaNetwork;
});

function makePreflightConnection({ mintValue, treasuryValue, genesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }) {
    let builtTransaction = false;
    return {
        connection: {
            getGenesisHash: async () => genesisHash,
            getParsedAccountInfo: async (publicKey, commitment) => {
                assert.equal(commitment, "finalized");
                return {
                    value: publicKey.toBase58() === RELICGRID_CYFUR_MINT_ADDRESS
                        ? mintValue
                        : treasuryValue
                };
            },
            getAccountInfo: async (_publicKey, commitment) => {
                assert.equal(commitment, "finalized");
                return null;
            },
            getLatestBlockhash: async () => {
                builtTransaction = true;
                throw new Error("Preflight should reject before building a transaction.");
            }
        },
        wasTransactionBuilt: () => builtTransaction
    };
}

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

test("withdrawal requires finalized official mint, treasury account, and sufficient funds before signing", async () => {
    const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const mintValue = {
        owner: tokenProgram,
        data: {
            parsed: {
                type: "mint",
                info: { decimals: 8, mintAuthority: null, freezeAuthority: null }
            }
        }
    };
    const treasuryValue = {
        owner: tokenProgram,
        data: {
            parsed: {
                type: "account",
                info: {
                    mint: RELICGRID_CYFUR_MINT_ADDRESS,
                    owner: RELICGRID_TREASURY_ADDRESS,
                    tokenAmount: { amount: "100000000" }
                }
            }
        }
    };
    const treasurySigner = {
        publicKey: { toBase58: () => RELICGRID_TREASURY_ADDRESS }
    };
    const playerWalletAddress = Keypair.generate().publicKey.toBase58();
    const cases = [
        {
            name: "mint mismatch",
            connection: makePreflightConnection({
                mintValue: { ...mintValue, owner: "11111111111111111111111111111111" },
                treasuryValue
            }).connection
        },
        {
            name: "treasury account mismatch",
            connection: makePreflightConnection({
                mintValue,
                treasuryValue: null
            }).connection
        },
        {
            name: "insufficient token funds",
            connection: makePreflightConnection({
                mintValue,
                treasuryValue: {
                    ...treasuryValue,
                    data: {
                        parsed: {
                            type: "account",
                            info: {
                                mint: RELICGRID_CYFUR_MINT_ADDRESS,
                                owner: RELICGRID_TREASURY_ADDRESS,
                                tokenAmount: { amount: "99999999" }
                            }
                        }
                    }
                }
            }).connection
        }
    ];

    for (const { name, connection } of cases) {
        await assert.rejects(
            executeCyfurWithdrawal({
                rpcUrl: "https://rpc.example",
                playerWalletAddress,
                treasurySigner,
                amountRaw: "100000000",
                connectionFactory: () => connection
            }),
            /finalized on-chain verification|missing, mismatched, or underfunded/i,
            name
        );
    }

    const wrongNetwork = makePreflightConnection({
        mintValue,
        treasuryValue,
        genesisHash: "wrong-network"
    });
    await assert.rejects(
        executeCyfurWithdrawal({
            rpcUrl: "https://rpc.example",
            playerWalletAddress,
            treasurySigner,
            amountRaw: "100000000",
            connectionFactory: () => wrongNetwork.connection
        }),
        /does not match the configured treasury network/i
    );
    assert.equal(wrongNetwork.wasTransactionBuilt(), false);
});
