import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PublicKey } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require("@solana/spl-token");
const {
    CYFUR_TEST_AMOUNT_RAW,
    CYFUR_TEST_RECIPIENT,
    executeCyfurTreasuryTestTransfer,
    readCyfurTreasuryTestPreflight
} = require("../server/lib/treasury-test-transfer.js");
const {
    createTreasuryTestTransferHandler,
    hasExpectedRequestBody,
    isAuthorizedOwner
} = require("../api/treasury-test-transfer.js");
const { encodeBase58 } = require("../server/lib/withdrawals.js");
const {
    createTreasuryTestTransferPreflightHandler
} = require("../server/lib/treasury-test-transfer-preflight.js");
const solana = require("../server/lib/solana-deposit.js");

const ownerToken = "A".repeat(43);
const transferSignature = "5".repeat(88);
const idempotencyKey = "f7075bd9-41aa-4f3b-a37d-97ed3576af41";
const originalEnv = { ...process.env };

function configureEnvironment(overrides = {}) {
    process.env.CYFUR_TEST_TRANSFER_OWNER_TOKEN = ownerToken;
    process.env.CYFUR_TEST_TRANSFER_ENABLED = "true";
    process.env.VERCEL_ENV = "production";
    process.env.SOLANA_NETWORK = "mainnet-beta";
    process.env.SOLANA_RPC_URL = "https://rpc.example.invalid";
    Object.assign(process.env, overrides);
}

function makeScenario({ executor } = {}) {
    const config = {
        network: "mainnet-beta",
        official_mint_address: solana.RELICGRID_CYFUR_MINT_ADDRESS,
        token_program_id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        token_decimals: 8,
        treasury_address: solana.RELICGRID_TREASURY_ADDRESS
    };
    const state = { record: null, calls: 0, sendCount: 0 };
    const requestDatabase = async (path, options = {}) => {
        if (path.startsWith("wallet_system_config")) return [config];
        if (path.startsWith("cyfur_treasury_test_transfers?select=")) {
            return state.record ? [{ ...state.record }] : [];
        }
        if (path.startsWith("cyfur_treasury_test_transfers?on_conflict=")) {
            if (state.record) return [];
            state.record = { ...JSON.parse(options.body) };
            return [{ transfer_id: state.record.transfer_id }];
        }
        if (path.includes("?transfer_id=eq.")) {
            const body = JSON.parse(options.body);
            if (!state.record || !path.includes(`status=eq.${state.record.status}`)) return [];
            Object.assign(state.record, body);
            return [{ ...state.record }];
        }
        throw new Error(`Unexpected database request: ${path}`);
    };
    const executeTransfer = executor ?? (async ({ onPrepared, onSigned }) => {
        state.calls += 1;
        state.sendCount += 1;
        await onPrepared({
            recipientTokenAccount: "3".repeat(44),
            recipientTokenAccountExists: true,
            recipientCyfurAmountRaw: "200000000",
            treasurySolLamports: 10000000,
            treasuryCyfurAmountRaw: "500000000",
            requiredRentLamports: 0,
            feeLamports: 5000
        });
        await onSigned(transferSignature);
        return {
            signature: transferSignature,
            recipientCyfurAmountRaw: "300000000"
        };
    });
    const handler = createTreasuryTestTransferHandler({
        databaseConfigured: () => true,
        requestDatabase,
        getSigner: () => ({ publicKey: { toBase58: () => solana.RELICGRID_TREASURY_ADDRESS } }),
        executeTransfer
    });
    return { handler, state, config };
}

function makeRequest(body, token = ownerToken) {
    return {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body
    };
}

function makeResponse() {
    return {
        statusCode: 200,
        headers: {},
        payload: null,
        status(code) {
            this.statusCode = code;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        json(payload) {
            this.payload = payload;
        }
    };
}

function validBody(overrides = {}) {
    return {
        recipient: CYFUR_TEST_RECIPIENT,
        amountRaw: CYFUR_TEST_AMOUNT_RAW,
        confirmation: "SEND EXACTLY 1 CYFUR TO APPROVED TEST WALLET",
        idempotencyKey,
        ...overrides
    };
}

function makeChainScenario({
    treasurySolLamports = 10000000,
    treasuryTokenBalanceRaw = "500000000",
    recipientExists = false,
    finalRecipientBalanceRaw = recipientExists ? "300000000" : "100000000",
    genesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
} = {}) {
    const treasury = new PublicKey(solana.RELICGRID_TREASURY_ADDRESS);
    const mint = new PublicKey(solana.RELICGRID_CYFUR_MINT_ADDRESS);
    const recipient = new PublicKey(CYFUR_TEST_RECIPIENT);
    const treasuryAta = getAssociatedTokenAddressSync(mint, treasury);
    const recipientAta = getAssociatedTokenAddressSync(mint, recipient);
    const signature = encodeBase58(Buffer.alloc(64, 7));
    const state = {
        sent: 0,
        signed: 0,
        confirmed: false,
        parsedRecipientReads: 0,
        feeRequested: false,
        instructions: []
    };
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
    const connection = {
        async getGenesisHash() { return genesisHash; },
        async getBalance() { return treasurySolLamports; },
        async getParsedAccountInfo(address) {
            const key = address.toBase58();
            if (key === mint.toBase58()) {
                return {
                    value: {
                        owner: TOKEN_PROGRAM_ID,
                        data: {
                            parsed: {
                                type: "mint",
                                info: { decimals: 8, mintAuthority: null, freezeAuthority: null }
                            }
                        }
                    }
                };
            }
            if (key === treasuryAta.toBase58()) {
                return { value: tokenAccount(treasury, treasuryTokenBalanceRaw) };
            }
            if (key === recipientAta.toBase58()) {
                state.parsedRecipientReads += 1;
                if (!recipientExists && state.parsedRecipientReads === 1) return { value: null };
                const balance = state.parsedRecipientReads === 1
                    ? "200000000"
                    : finalRecipientBalanceRaw;
                return { value: tokenAccount(recipient, balance) };
            }
            throw new Error("Unexpected account lookup.");
        },
        async getMinimumBalanceForRentExemption(size) {
            assert.equal(size, 165);
            return 2000000;
        },
        async getLatestBlockhash() {
            return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 123 };
        },
        async getFeeForMessage() {
            state.feeRequested = true;
            return { value: 5000 };
        },
        async sendRawTransaction() {
            state.sent += 1;
            return signature;
        },
        async confirmTransaction(strategy, commitment) {
            assert.equal(strategy.signature, signature);
            assert.equal(commitment, "finalized");
            state.confirmed = true;
            return { value: { err: null } };
        }
    };
    class TestTransaction {
        add(...instructions) {
            state.instructions.push(...instructions);
            return this;
        }
        compileMessage() { return {}; }
        sign(signer) {
            assert.equal(signer.publicKey.toBase58(), treasury.toBase58());
            state.signed += 1;
            this.signature = Buffer.alloc(64, 7);
        }
        serialize() { return Buffer.from("signed-test-transaction"); }
    }
    return {
        state,
        signature,
        treasurySigner: { publicKey: treasury },
        connectionFactory: () => connection,
        transactionFactory: () => new TestTransaction()
    };
}

function makeHandlerResponse() {
    return {
        statusCode: 200,
        headers: {},
        payload: null,
        status(code) {
            this.statusCode = code;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        json(payload) {
            this.payload = payload;
        }
    };
}

test("owner authorization requires a long exact bearer token and fixed transfer parameters", () => {
    configureEnvironment();
    assert.equal(isAuthorizedOwner(makeRequest({}, ownerToken), ownerToken), true);
    assert.equal(isAuthorizedOwner(makeRequest({}, `${ownerToken}x`), ownerToken), false);
    assert.equal(isAuthorizedOwner(makeRequest({}, "short"), "short"), false);
    assert.equal(hasExpectedRequestBody(validBody()), true);
    assert.equal(hasExpectedRequestBody(validBody({ recipient: "11111111111111111111111111111111" })), false);
    assert.equal(hasExpectedRequestBody(validBody({ amountRaw: "1000000000" })), false);
});

test("test transfer rejects missing owner authorization without calling the signer or sender", async () => {
    configureEnvironment();
    const { handler, state } = makeScenario();
    const response = makeResponse();
    await handler(makeRequest(validBody(), "incorrect-owner-token-value-that-is-long-enough"), response);
    assert.equal(response.statusCode, 401);
    assert.equal(state.calls, 0);
    assert.equal(state.sendCount, 0);
});

test("test transfer rejects a wrong recipient or amount before reservation", async () => {
    configureEnvironment();
    for (const body of [
        validBody({ recipient: "11111111111111111111111111111111" }),
        validBody({ amountRaw: "1000000000" })
    ]) {
        const { handler, state } = makeScenario();
        const response = makeResponse();
        await handler(makeRequest(body), response);
        assert.equal(response.statusCode, 400);
        assert.equal(state.record, null);
        assert.equal(state.calls, 0);
    }
});

test("one-time transfer reservation prevents duplicate requests from sending again", async () => {
    configureEnvironment();
    const { handler, state } = makeScenario();
    const first = makeResponse();
    await handler(makeRequest(validBody()), first);
    assert.equal(first.statusCode, 200);
    assert.equal(first.payload.status, "confirmed");
    assert.equal(first.payload.amountRaw, "100000000");
    assert.equal(first.payload.recipient, CYFUR_TEST_RECIPIENT);
    assert.equal(first.payload.signature, transferSignature);
    assert.equal(state.record.status, "confirmed");

    const retry = makeResponse();
    await handler(makeRequest(validBody({
        idempotencyKey: "b2e0eb47-fb6f-4c7f-aaed-80edf3fe3a54"
    })), retry);
    assert.equal(retry.statusCode, 409);
    assert.equal(state.calls, 1);
    assert.equal(state.sendCount, 1);
});

test("insufficient treasury preflight prevents reservation and broadcast", async () => {
    configureEnvironment();
    const { handler, state } = makeScenario({
        executor: async () => {
            state.calls += 1;
            throw new Error("The treasury SOL balance is insufficient for the current ATA rent and transaction fee.");
        }
    });
    const response = makeResponse();
    await handler(makeRequest(validBody()), response);
    assert.equal(response.statusCode, 502);
    assert.match(response.payload.message, /SOL balance is insufficient/);
    assert.equal(state.record, null);
    assert.equal(state.sendCount, 0);
});

test("mainnet configuration and successful finalized balance verification are enforced", async () => {
    configureEnvironment();
    const { handler, state, config } = makeScenario();
    const response = makeResponse();
    await handler(makeRequest(validBody()), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.status, "confirmed");
    assert.equal(response.payload.recipientBalanceRaw, "300000000");
    assert.equal(state.record.recipient_balance_raw, "300000000");
    assert.equal(config.network, "mainnet-beta");
    assert.equal(state.record.amount_raw, "100000000");
});

test("Supabase migration constrains the one-time transfer record to approved values", () => {
    const migration = readFileSync(
        new URL("../supabase-cyfur-treasury-test-transfer.sql", import.meta.url),
        "utf8"
    );
    assert.match(migration, /transfer_id = 'cyfur-mainnet-one-cyfur-v1'/);
    assert.match(migration, /amount_raw = 100000000/);
    assert.match(migration, /recipient = '4bSjz5zdgReegh9TwCgiPWn7BH1nUhfY3s1DwZdK3UT1'/);
    assert.match(migration, /status <> 'confirmed'[\s\S]*?recipient_balance_before_raw \+ 100000000/);
    assert.match(migration, /revoke all on public\.cyfur_treasury_test_transfers from public, anon, authenticated/i);
});

test("Solana executor creates the recipient ATA and verifies exactly one CYFUR after finalization", async () => {
    process.env.SOLANA_NETWORK = "mainnet-beta";
    const scenario = makeChainScenario();
    let prepared = null;
    let signed = null;
    const result = await executeCyfurTreasuryTestTransfer({
        ...scenario,
        validateSigner: () => true,
        onPrepared: async (value) => { prepared = value; },
        onSigned: async (value) => { signed = value; }
    });
    assert.equal(prepared.amountRaw, "100000000");
    assert.equal(prepared.recipientTokenAccountExists, false);
    assert.equal(prepared.requiredRentLamports, 2000000);
    assert.equal(signed, scenario.signature);
    assert.equal(scenario.state.feeRequested, true);
    assert.equal(scenario.state.instructions.length, 2);
    assert.equal(scenario.state.sent, 1);
    assert.equal(scenario.state.confirmed, true);
    assert.equal(result.status, "confirmed");
    assert.equal(result.recipientCyfurAmountRaw, "100000000");
});

test("Solana executor refuses insufficient SOL or CYFUR before signing and broadcasting", async () => {
    process.env.SOLANA_NETWORK = "mainnet-beta";
    for (const options of [
        { treasurySolLamports: 1000 },
        { treasuryTokenBalanceRaw: "99999999" }
    ]) {
        const scenario = makeChainScenario(options);
        await assert.rejects(
            executeCyfurTreasuryTestTransfer({ ...scenario, validateSigner: () => true }),
            /insufficient|underfunded/
        );
        assert.equal(scenario.state.signed, 0);
        assert.equal(scenario.state.sent, 0);
    }
});

test("Solana executor rejects non-mainnet RPC and a mismatched finalized recipient balance", async () => {
    process.env.SOLANA_NETWORK = "mainnet-beta";
    const wrongNetwork = makeChainScenario({ genesisHash: "not-mainnet" });
    await assert.rejects(
        executeCyfurTreasuryTestTransfer({ ...wrongNetwork, validateSigner: () => true }),
        /not mainnet-beta/
    );
    assert.equal(wrongNetwork.state.sent, 0);

    const wrongBalance = makeChainScenario({ finalRecipientBalanceRaw: "100000001" });
    await assert.rejects(
        executeCyfurTreasuryTestTransfer({ ...wrongBalance, validateSigner: () => true }),
        /did not increase by exactly 1 CYFUR/
    );
    assert.equal(wrongBalance.state.confirmed, true);
    assert.equal(wrongBalance.state.sent, 1);
});

test("read-only chain preflight reports live checks without signing or sending", async () => {
    process.env.SOLANA_NETWORK = "mainnet-beta";
    const scenario = makeChainScenario();
    const result = await readCyfurTreasuryTestPreflight({
        ...scenario,
        validateSigner: () => true
    });
    assert.equal(result.network, "mainnet-beta");
    assert.equal(result.currentAtaRentLamports, 2000000);
    assert.equal(result.recipientTokenAccountExists, false);
    assert.equal(result.enoughCyfur, true);
    assert.equal(result.enoughSol, true);
    assert.equal(scenario.state.sent, 0);
    assert.equal(scenario.state.signed, 0);
});

test("production preflight validates owner token, enabled flag, Supabase reads, signer, and chain readiness without writes", async () => {
    configureEnvironment();
    let databaseWrites = 0;
    let transferCalls = 0;
    const signer = { publicKey: { toBase58: () => solana.RELICGRID_TREASURY_ADDRESS } };
    const handler = createTreasuryTestTransferPreflightHandler({
        databaseConfigured: () => true,
        getSigner: () => signer,
        requestDatabase: async (path, options = {}) => {
            if (options.method && options.method !== "GET") databaseWrites += 1;
            if (path.startsWith("wallet_system_config")) {
                return [{
                    network: "mainnet-beta",
                    official_mint_address: solana.RELICGRID_CYFUR_MINT_ADDRESS,
                    token_program_id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                    token_decimals: 8,
                    treasury_address: solana.RELICGRID_TREASURY_ADDRESS
                }];
            }
            return [];
        },
        readChain: async () => {
            transferCalls += 1;
            return {
                network: "mainnet-beta",
                genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
                treasuryAddress: solana.RELICGRID_TREASURY_ADDRESS,
                treasurySolLamports: 10000000,
                treasuryCyfurAmountRaw: "500000000",
                treasuryTokenAccount: "TreasuryAta",
                mintAddress: solana.RELICGRID_CYFUR_MINT_ADDRESS,
                tokenProgramAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                tokenDecimals: 8,
                recipient: CYFUR_TEST_RECIPIENT,
                recipientTokenAccount: "RecipientAta",
                recipientTokenAccountExists: false,
                recipientCyfurAmountRaw: "0",
                currentAtaRentLamports: 1488440,
                estimatedFeeLamports: 5000,
                requiredSolLamports: 1493440,
                enoughCyfur: true,
                enoughSol: true
            };
        }
    });
    const response = makeHandlerResponse();
    await handler({
        method: "GET",
        headers: { authorization: `Bearer ${ownerToken}` }
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.readyToExecute, true);
    assert.equal(response.payload.readOnly, true);
    assert.equal(response.payload.transactionSubmitted, false);
    assert.equal(response.payload.checks.ownerTokenVerified, true);
    assert.equal(response.payload.checks.testTransferEnabled, true);
    assert.equal(response.payload.checks.signerMatchesTreasury, true);
    assert.equal(response.payload.checks.supabaseTestTableAccessible, true);
    assert.equal(response.payload.checks.oneTimeTransferRecordExists, false);
    assert.equal(databaseWrites, 0);
    assert.equal(transferCalls, 1);
});

test("treasury test-transfer route sends GET to read-only preflight and keeps POST separate", async () => {
    let preflightCalls = 0;
    let transferCalls = 0;
    const handler = createTreasuryTestTransferHandler({
        preflightHandler: async (_request, response) => {
            preflightCalls += 1;
            response.status(200);
            response.json({ readOnly: true, transactionSubmitted: false });
        },
        executeTransfer: async () => {
            transferCalls += 1;
            throw new Error("POST transfer must not be used by GET.");
        }
    });
    const response = makeHandlerResponse();
    await handler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload, { readOnly: true, transactionSubmitted: false });
    assert.equal(preflightCalls, 1);
    assert.equal(transferCalls, 0);
});

test("production preflight cannot proceed when disabled, unauthorized, or already reserved", async () => {
    configureEnvironment();
    let signerReads = 0;
    const handler = createTreasuryTestTransferPreflightHandler({
        databaseConfigured: () => true,
        getSigner: () => {
            signerReads += 1;
            return { publicKey: { toBase58: () => solana.RELICGRID_TREASURY_ADDRESS } };
        },
        requestDatabase: async (path) => path.startsWith("wallet_system_config")
            ? [{
                network: "mainnet-beta",
                official_mint_address: solana.RELICGRID_CYFUR_MINT_ADDRESS,
                token_program_id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                token_decimals: 8,
                treasury_address: solana.RELICGRID_TREASURY_ADDRESS
            }]
            : [{ transfer_id: "cyfur-mainnet-one-cyfur-v1", status: "confirmed" }],
        readChain: async () => {
            throw new Error("Chain checks must not run for an existing reservation.");
        }
    });
    process.env.CYFUR_TEST_TRANSFER_ENABLED = "false";
    const disabled = makeHandlerResponse();
    await handler({ method: "GET", headers: { authorization: `Bearer ${ownerToken}` } }, disabled);
    assert.equal(disabled.payload.readyToExecute, false);
    assert.equal(disabled.payload.checks.testTransferEnabled, false);
    assert.equal(signerReads, 0);

    process.env.CYFUR_TEST_TRANSFER_ENABLED = "true";
    const unauthorized = makeHandlerResponse();
    await handler({ method: "GET", headers: { authorization: "Bearer incorrect-token" } }, unauthorized);
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(signerReads, 0);

    const duplicate = makeHandlerResponse();
    await handler({ method: "GET", headers: { authorization: `Bearer ${ownerToken}` } }, duplicate);
    assert.equal(duplicate.payload.readyToExecute, false);
    assert.equal(duplicate.payload.checks.oneTimeTransferRecordExists, true);
    assert.equal(duplicate.payload.blocker, "one_time_transfer_already_reserved");
});

test.after(() => {
    for (const name of Object.keys(process.env)) {
        if (!(name in originalEnv)) delete process.env[name];
    }
    Object.assign(process.env, originalEnv);
});
