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
const { Keypair, PublicKey } = require("@solana/web3.js");
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
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
    const mint = new PublicKey(RELICGRID_CYFUR_MINT_ADDRESS);
    const treasuryAta = getAssociatedTokenAddressSync(
        mint,
        new PublicKey(RELICGRID_TREASURY_ADDRESS)
    );
    return {
        connection: {
            getGenesisHash: async () => genesisHash,
            getParsedAccountInfo: async (publicKey, commitment) => {
                assert.equal(commitment, "finalized");
                return {
                    value: publicKey.toBase58() === RELICGRID_CYFUR_MINT_ADDRESS
                        ? mintValue
                        : publicKey.equals(treasuryAta) ? treasuryValue : null
                };
            },
            getBalance: async (_publicKey, commitment) => {
                assert.equal(commitment, "finalized");
                return 0;
            },
            getMinimumBalanceForRentExemption: async (_size, commitment) => {
                assert.equal(commitment, "finalized");
                return 2000000;
            },
            getFeeForMessage: async (_message, commitment) => {
                assert.equal(commitment, "finalized");
                return { value: 5000 };
            },
            getLatestBlockhash: async () => {
                builtTransaction = true;
                return {
                    blockhash: PublicKey.default.toBase58(),
                    lastValidBlockHeight: 55
                };
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

test("withdrawal preflight accepts web3 PublicKey owners returned by parsed-account RPC", async () => {
    const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
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
    const preflight = makePreflightConnection({ mintValue, treasuryValue });

    await assert.rejects(
        executeCyfurWithdrawal({
            rpcUrl: "https://rpc.example",
            playerWalletAddress: Keypair.generate().publicKey.toBase58(),
            treasurySigner: {
                publicKey: { toBase58: () => RELICGRID_TREASURY_ADDRESS }
            },
            amountRaw: "100000000",
            connectionFactory: () => preflight.connection
        }),
        /SOL balance is insufficient/i
    );
    assert.equal(preflight.wasTransactionBuilt(), true);
});

test("withdrawal checks current rent and fees, creates a missing ATA, finalizes, and verifies exact receipt", async () => {
    const treasury = new PublicKey(RELICGRID_TREASURY_ADDRESS);
    const mint = new PublicKey(RELICGRID_CYFUR_MINT_ADDRESS);
    const player = Keypair.generate().publicKey;
    const treasuryAta = getAssociatedTokenAddressSync(mint, treasury);
    const playerAta = getAssociatedTokenAddressSync(mint, player);
    const treasurySigner = { publicKey: treasury };
    const signatureBytes = Buffer.alloc(64, 9);
    const signature = require("../server/lib/withdrawals.js").encodeBase58(signatureBytes);
    const state = { sent: false, signed: false, confirmed: false, rentSize: null, feeRequested: false };
    const tokenAccount = (owner, amount) => ({
        owner: TOKEN_PROGRAM_ID,
        data: {
            parsed: {
                type: "account",
                info: {
                    mint: mint.toBase58(),
                    owner: owner.toBase58(),
                    tokenAmount: { amount }
                }
            }
        }
    });
    const mintAccount = {
        owner: TOKEN_PROGRAM_ID,
        data: {
            parsed: {
                type: "mint",
                info: { decimals: 8, mintAuthority: null, freezeAuthority: null }
            }
        }
    };
    const connection = {
        async getGenesisHash() {
            return "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
        },
        async getParsedAccountInfo(address) {
            if (address.equals(mint)) return { value: mintAccount };
            if (address.equals(treasuryAta)) {
                return { value: tokenAccount(treasury, "500000000") };
            }
            if (address.equals(playerAta)) {
                return { value: state.sent ? tokenAccount(player, "100000000") : null };
            }
            throw new Error("Unexpected account lookup.");
        },
        async getBalance(address, commitment) {
            assert(address.equals(treasury));
            assert.equal(commitment, "finalized");
            return 2005000;
        },
        async getMinimumBalanceForRentExemption(size, commitment) {
            assert.equal(commitment, "finalized");
            state.rentSize = size;
            return 2000000;
        },
        async getLatestBlockhash(commitment) {
            assert.equal(commitment, "finalized");
            return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 55 };
        },
        async getFeeForMessage(message, commitment) {
            assert.deepEqual(message, { message: true });
            assert.equal(commitment, "finalized");
            state.feeRequested = true;
            return { value: 5000 };
        },
        async sendRawTransaction(serialized) {
            assert.deepEqual(serialized, Buffer.from("signed"));
            state.sent = true;
            return signature;
        },
        async confirmTransaction(strategy, commitment) {
            assert.equal(strategy.signature, signature);
            assert.equal(commitment, "finalized");
            state.confirmed = true;
            return { value: { err: null } };
        }
    };
    const result = await executeCyfurWithdrawal({
        rpcUrl: "https://rpc.example",
        playerWalletAddress: player.toBase58(),
        amountRaw: "100000000",
        treasurySigner,
        connectionFactory: () => connection,
        transactionFactory: () => ({
            instructions: [],
            add(...instructions) {
                this.instructions.push(...instructions);
                return this;
            },
            compileMessage() {
                return { message: true };
            },
            async sign(signer) {
                assert.equal(signer, treasurySigner);
                state.signed = true;
                this.signature = signatureBytes;
            },
            serialize() {
                return Buffer.from("signed");
            }
        })
    });
    assert.equal(result.status, "finalized");
    assert.equal(result.signature, signature);
    assert.equal(result.recipientBalanceRaw, "100000000");
    assert.equal(result.requiredRentLamports, 2000000);
    assert.equal(result.feeLamports, 5000);
    assert.equal(state.rentSize, 165);
    assert.equal(state.feeRequested, true);
    assert.equal(state.signed, true);
    assert.equal(state.sent, true);
    assert.equal(state.confirmed, true);
});

test("withdrawal refuses insufficient treasury SOL before signing or sending", async () => {
    const { connection } = makePreflightConnection({
        mintValue: {
            owner: TOKEN_PROGRAM_ID,
            data: {
                parsed: {
                    type: "mint",
                    info: { decimals: 8, mintAuthority: null, freezeAuthority: null }
                }
            }
        },
        treasuryValue: {
            owner: TOKEN_PROGRAM_ID,
            data: {
                parsed: {
                    type: "account",
                    info: {
                        mint: RELICGRID_CYFUR_MINT_ADDRESS,
                        owner: RELICGRID_TREASURY_ADDRESS,
                        tokenAmount: { amount: "500000000" }
                    }
                }
            }
        }
    });
    let signed = false;
    let sent = false;
    await assert.rejects(executeCyfurWithdrawal({
        rpcUrl: "https://rpc.example",
        playerWalletAddress: Keypair.generate().publicKey.toBase58(),
        amountRaw: "100000000",
        treasurySigner: {
            publicKey: { toBase58: () => RELICGRID_TREASURY_ADDRESS }
        },
        connectionFactory: () => connection,
        transactionFactory: () => ({
            add() { return this; },
            compileMessage() { return {}; },
            async sign() { signed = true; },
            serialize() { return Buffer.from("signed"); }
        })
    }), /SOL balance is insufficient/i);
    assert.equal(signed, false);
    assert.equal(sent, false);
});
