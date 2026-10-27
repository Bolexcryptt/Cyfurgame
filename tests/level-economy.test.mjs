import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import {
    bytesToWalletBase64,
    connectPhantom,
    createPhantomBrowseUrl,
    decodeWalletBytes,
    decryptPhantomMobileResponse,
    encodeWalletBytes,
    getConnectedPhantomWallet,
    getDepositPreparationFieldErrors,
    getFeePayerPreflightError,
    getPhantomProvider,
    getSolFundingStatus,
    isLinkedPhantomWallet,
    isMobileBrowser,
    readPhantomMobileCallback,
    rebuildMobileDepositAfterBlockhashRejection,
    savePhantomMobileSession,
    signAndBroadcastWithBlockhashRetry,
    startPhantomMobileConnect,
    waitForPhantomProvider
} from "../wallet-provider.mjs";
import { calculateSolveTimeMilliseconds, claimLevelCompletion, CYFUR_CREDITS_PER_TOKEN, evaluateLevelStars, getLevelEconomy, getLevelStarTimeTargets, levels } from "../levels.js";

const require = createRequire(import.meta.url);
const nacl = require("tweetnacl");
const {
    CYFUR_CREDITS_PER_TOKEN: apiCreditsPerToken,
    getDepositCreditAmount,
    getLevelEntryCostCredits,
    parseTokenAmount
} = require("../server/lib/wallet.js");
const {
    deriveAssociatedTokenAccount,
    isOfficialCyfurMintAccount,
    normalizeTransactionSignature,
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS,
    verifyFinalizedDeposit
} = require("../server/lib/solana-deposit.js");
const { getLevelEconomyAndStars, verifyLevelProof } = require("../server/lib/level-completion.js");
const { verifyWalletSignature } = require("../server/lib/solana-wallet-link.js");

function encodeBase58(bytes) {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
    let encoded = "";
    while (value > 0n) {
        encoded = alphabet[Number(value % 58n)] + encoded;
        value /= 58n;
    }
    for (const byte of bytes) {
        if (byte !== 0) break;
        encoded = `1${encoded}`;
    }
    return encoded;
}

test("Phantom provider detection supports current and legacy injection without accepting other wallets", () => {
    const currentProvider = { isPhantom: true, connect() {}, signMessage() {} };
    assert.equal(getPhantomProvider({ phantom: { solana: currentProvider } }), currentProvider);
    assert.equal(getPhantomProvider({ solana: currentProvider }), currentProvider);
    assert.equal(getPhantomProvider({ solana: { isPhantom: false, connect() {}, signMessage() {} } }), null);
});

test("deposit signature input accepts raw signatures and trusted explorer links only", () => {
    const signature = "1".repeat(64);
    assert.equal(normalizeTransactionSignature(signature), signature);
    assert.equal(
        normalizeTransactionSignature(`https://explorer.solana.com/tx/${signature}?cluster=mainnet-beta`),
        signature
    );
    assert.equal(normalizeTransactionSignature(`https://solscan.io/tx/${signature}`), signature);
    assert.equal(normalizeTransactionSignature(`https://evil.example/tx/${signature}`), null);
    assert.equal(normalizeTransactionSignature(`http://explorer.solana.com/tx/${signature}`), null);
    assert.equal(normalizeTransactionSignature(`https://explorer.solana.com/account/${signature}`), null);
    assert.equal(normalizeTransactionSignature("not-a-transaction"), null);
});

test("Phantom Wallet Standard registration supports connect, ownership signing, and transaction approval", async () => {
    const events = new EventTarget();
    const account = { address: "wallet-address", chains: ["solana:mainnet"] };
    const signatureBytes = Uint8Array.from([1, 2, 3]);
    let connected = false;
    let messageSigned = false;
    let transactionApproved = false;
    const wallet = {
        name: "Phantom",
        chains: ["solana:mainnet"],
        features: {
            "standard:connect": {
                async connect() { connected = true; return { accounts: [account] }; }
            },
            "solana:signMessage": {
                async signMessage(input) {
                    messageSigned = input.account === account;
                    return [{ signature: signatureBytes }];
                }
            },
            "solana:signTransaction": {
                async signTransaction() {
                    return [{ signedTransaction: Uint8Array.from([4, 5, 6]) }];
                }
            },
            "solana:signAndSendTransaction": {
                async signAndSendTransaction(input) {
                    transactionApproved = input.account === account &&
                        input.chain === "solana:mainnet" &&
                        input.transaction[0] === 7;
                    return [{ signature: signatureBytes }];
                }
            }
        }
    };
    events.addEventListener("wallet-standard:app-ready", (event) => {
        event.detail.register(wallet);
    });

    const provider = getPhantomProvider(events);
    assert.ok(provider);
    assert.equal((await provider.connect()).publicKey.toString(), account.address);
    assert.equal((await provider.signMessage(new Uint8Array([9]))).signature, signatureBytes);
    const result = await provider.sendTransaction(
        { serialize: () => Uint8Array.from([7]) },
        {},
        { chain: "mainnet-beta" }
    );
    assert.equal(result.signature, encodeBase58(signatureBytes));
    assert.equal(connected, true);
    assert.equal(messageSigned, true);
    assert.equal(transactionApproved, true);
    assert.deepEqual(
        await provider.signTransaction({ serialize: () => Uint8Array.from([7]) }),
        Uint8Array.from([4, 5, 6])
    );
});

test("blockhash rejection fetches a fresh transaction and requires a second Phantom signature", async () => {
    const events = [];
    const preparations = [
        { blockhash: "old-blockhash", contextSlot: 100 },
        { blockhash: "fresh-blockhash", contextSlot: 125 }
    ];
    const result = await signAndBroadcastWithBlockhashRetry({
        async prepare() {
            const preparation = preparations.shift();
            events.push(["prepare", preparation.blockhash]);
            return preparation;
        },
        async build(preparation) {
            events.push(["build", preparation.blockhash]);
            return { blockhash: preparation.blockhash };
        },
        async sign(transaction) {
            events.push(["sign", transaction.blockhash]);
            return `signed:${transaction.blockhash}`;
        },
        async broadcast(signedTransaction) {
            events.push(["broadcast", signedTransaction]);
            if (signedTransaction === "signed:old-blockhash") {
                throw Object.assign(new Error("blockhash not found"), { code: "blockhash_expired" });
            }
            return { signature: "confirmed-signature" };
        }
    });

    assert.deepEqual(result, { signature: "confirmed-signature" });
    assert.deepEqual(events, [
        ["prepare", "old-blockhash"],
        ["build", "old-blockhash"],
        ["sign", "old-blockhash"],
        ["broadcast", "signed:old-blockhash"],
        ["prepare", "fresh-blockhash"],
        ["build", "fresh-blockhash"],
        ["sign", "fresh-blockhash"],
        ["broadcast", "signed:fresh-blockhash"]
    ]);
});

test("mobile blockhash recovery rebuilds once from fresh preparation for the same unexpired intent", async () => {
    const events = [];
    const state = {
        action: "deposit-sign",
        paymentIntentId: "8f9ef883-520e-45ef-96ae-62e621d3b31c",
        paymentIntentAmountRaw: "125000000",
        paymentIntentExpiresAt: "2030-01-01T00:15:00.000Z",
        blockhashRetryCount: 0
    };
    const result = await rebuildMobileDepositAfterBlockhashRejection({
        error: Object.assign(new Error("server rejected stale blockhash"), {
            code: "blockhash_expired"
        }),
        state,
        async prepare() {
            events.push("prepare");
            return { blockhash: "fresh-mobile-blockhash" };
        },
        async build(preparation, intentState) {
            events.push(["build", preparation.blockhash, intentState.paymentIntentId]);
            return { blockhash: preparation.blockhash };
        },
        now: () => Date.parse("2029-12-31T23:59:00.000Z")
    });

    assert.deepEqual(result, {
        transaction: { blockhash: "fresh-mobile-blockhash" },
        blockhashRetryCount: 1
    });
    assert.deepEqual(events, [
        "prepare",
        ["build", "fresh-mobile-blockhash", state.paymentIntentId]
    ]);
});

test("mobile blockhash recovery refuses unrelated, expired, invalid, or repeated requests", async () => {
    let operationCount = 0;
    const options = {
        state: {
            action: "deposit-sign",
            paymentIntentId: "8f9ef883-520e-45ef-96ae-62e621d3b31c",
            paymentIntentAmountRaw: "125000000",
            paymentIntentExpiresAt: "2030-01-01T00:15:00.000Z",
            blockhashRetryCount: 0
        },
        async prepare() { operationCount += 1; return {}; },
        async build() { operationCount += 1; return {}; },
        now: () => Date.parse("2029-12-31T23:59:00.000Z")
    };
    await assert.rejects(
        rebuildMobileDepositAfterBlockhashRejection({
            ...options,
            error: Object.assign(new Error("simulation failed"), { code: "solana_rpc_unavailable" })
        }),
        { code: "solana_rpc_unavailable" }
    );
    await assert.rejects(rebuildMobileDepositAfterBlockhashRejection({
        ...options,
        error: Object.assign(new Error("stale"), { code: "blockhash_expired" }),
        state: { ...options.state, blockhashRetryCount: 1 }
    }), /cannot be safely refreshed/);
    await assert.rejects(rebuildMobileDepositAfterBlockhashRejection({
        ...options,
        error: Object.assign(new Error("stale"), { code: "blockhash_expired" }),
        state: { ...options.state, paymentIntentExpiresAt: "2029-12-31T23:58:59.000Z" }
    }), /cannot be safely refreshed/);
    await assert.rejects(rebuildMobileDepositAfterBlockhashRejection({
        ...options,
        error: Object.assign(new Error("stale"), { code: "blockhash_expired" }),
        state: { ...options.state, paymentIntentAmountRaw: "18446744073709551616" }
    }), /cannot be safely refreshed/);
    assert.equal(operationCount, 0);
});

test("deposit preparation validation matches API JSON and identifies invalid field names safely", () => {
    const apiResponse = {
        blockhash: "11111111111111111111111111111116",
        lastValidBlockHeight: 123,
        senderTokenAccounts: ["11111111111111111111111111111113"],
        treasuryTokenAccounts: ["11111111111111111111111111111114"]
    };
    assert.deepEqual(getDepositPreparationFieldErrors(apiResponse), []);
    assert.deepEqual(getDepositPreparationFieldErrors({
        ...apiResponse,
        lastValidBlockHeight: "123",
        senderTokenAccounts: undefined
    }), [
        {
            field: "lastValidBlockHeight",
            actualType: "string",
            isSafeInteger: false,
            isPositive: false
        },
        { field: "senderTokenAccounts", actualType: "undefined" }
    ]);
    assert.deepEqual(getDepositPreparationFieldErrors({
        ...apiResponse,
        blockhash: "not-a-blockhash",
        treasuryTokenAccounts: [null]
    }), [
        { field: "blockhash", actualType: "string", actualLength: 15 },
        {
            field: "treasuryTokenAccounts",
            actualType: "array",
            arrayLength: 1,
            invalidAccountCount: 1
        }
    ]);
});

test("SOL funding preflight calculates the ATA rent and fee shortfall before wallet approval", () => {
    const result = getSolFundingStatus({
        payerLamports: 919037,
        requiredTotalLamports: 1493440
    });
    assert.deepEqual(result, {
        status: "insufficient",
        balanceLamports: 919037,
        requiredLamports: 1493440,
        shortfallLamports: 574403
    });
    assert.equal(getSolFundingStatus({
        payerLamports: 1493440,
        requiredTotalLamports: 1493440
    }).status, "sufficient");
    assert.equal(getSolFundingStatus({
        payerLamports: null,
        requiredTotalLamports: 1493440
    }).status, "unknown");
});

test("fee-payer preflight rejects a missing, non-system, or mismatched payer account", () => {
    const valid = {
        feePayerAccountExists: true,
        feePayerSystemProgramOwned: true,
        feePayerKeyMatchesConnectedPhantom: true,
        feePayerKeyMatchesLinkedWallet: true,
        payerBalanceQueryMatchesFeePayer: true
    };
    assert.equal(getFeePayerPreflightError(valid), null);
    assert.match(getFeePayerPreflightError({
        ...valid,
        feePayerAccountExists: false
    }), /does not exist/i);
    assert.match(getFeePayerPreflightError({
        ...valid,
        feePayerSystemProgramOwned: false
    }), /not owned by the Solana System Program/i);
    assert.match(getFeePayerPreflightError({
        ...valid,
        feePayerKeyMatchesConnectedPhantom: false
    }), /does not match/i);
    assert.match(getFeePayerPreflightError({
        ...valid,
        payerBalanceQueryMatchesFeePayer: false
    }), /does not match/i);
    assert.match(getFeePayerPreflightError({}), /does not match/i);
});

test("deposit flow requires the connected Phantom key to match the server-linked wallet", () => {
    const linkedAddress = "GsDBmSGr1sVy7YoDxzZekwQYeSxrxCUpTswwzbA81Har";
    const wrongLinkedAddress = "FWc2DZyCf4dCwJXRavjNxssuz4ppPhd3ie1Tvb36jYs7";
    assert.equal(isLinkedPhantomWallet({ publicKey: linkedAddress }, linkedAddress), true);
    assert.equal(isLinkedPhantomWallet({ publicKey: linkedAddress }, wrongLinkedAddress), false);
    assert.equal(isLinkedPhantomWallet(null, linkedAddress), false);
});

test("blockhash retry does not retry non-blockhash or repeated broadcast failures", async () => {
    let preparationCount = 0;
    let signatureCount = 0;
    await assert.rejects(
        signAndBroadcastWithBlockhashRetry({
            async prepare() {
                preparationCount += 1;
                return { blockhash: `blockhash-${preparationCount}` };
            },
            async build(preparation) {
                return preparation;
            },
            async sign() {
                signatureCount += 1;
                return `signed-${signatureCount}`;
            },
            async broadcast() {
                throw Object.assign(new Error("RPC unavailable"), { code: "solana_rpc_unavailable" });
            }
        }),
        { code: "solana_rpc_unavailable" }
    );
    assert.equal(preparationCount, 1);
    assert.equal(signatureCount, 1);

    preparationCount = 0;
    signatureCount = 0;
    await assert.rejects(
        signAndBroadcastWithBlockhashRetry({
            async prepare() {
                preparationCount += 1;
                return { blockhash: `blockhash-${preparationCount}` };
            },
            async build(preparation) {
                return preparation;
            },
            async sign() {
                signatureCount += 1;
                return `signed-${signatureCount}`;
            },
            async broadcast() {
                throw Object.assign(new Error("Blockhash not found"), { code: "blockhash_expired" });
            }
        }),
        { code: "blockhash_expired" }
    );
    assert.equal(preparationCount, 2);
    assert.equal(signatureCount, 2);
});

test("Phantom provider discovery waits briefly for delayed extension injection", async () => {
    const target = {};
    setTimeout(() => {
        target.phantom = { solana: { isPhantom: true, connect() {}, signMessage() {} } };
    }, 20);
    const provider = await waitForPhantomProvider(target, 200);
    assert.equal(provider, target.phantom.solana);
});

test("connect and later wallet actions reuse the same connected provider and address", async () => {
    const listeners = new Map();
    let connectCount = 0;
    const provider = {
        isPhantom: true,
        isConnected: true,
        connect() {
            connectCount += 1;
            return Promise.resolve({ publicKey: { toString: () => "linked-public-address" } });
        },
        signMessage() {},
        on(event, listener) { listeners.set(event, listener); }
    };
    const walletWindow = { phantom: { solana: provider } };
    const first = await connectPhantom(walletWindow);
    const second = await connectPhantom(walletWindow);
    assert.equal(first.provider, provider);
    assert.equal(second.provider, provider);
    assert.equal(second.publicKey, "linked-public-address");
    assert.deepEqual(getConnectedPhantomWallet(walletWindow), second);
    assert.equal(connectCount, 1);
    listeners.get("disconnect")();
    assert.equal(getConnectedPhantomWallet(walletWindow), null);
});

test("Phantom mobile deeplink encrypts connect and message-sign requests and restores the browser session", async () => {
    const storage = new Map();
    let assignedUrl = "";
    const walletWindow = {
        nacl,
        location: { href: "https://cyfur-game-mu.vercel.app/?screen=home", assign(url) { assignedUrl = url; } },
        localStorage: {
            getItem(key) { return storage.get(key) ?? null; },
            setItem(key, value) { storage.set(key, value); },
            removeItem(key) { storage.delete(key); }
        },
        history: {
            replaceState(_state, _title, href) { walletWindow.location.href = href; }
        }
    };

    startPhantomMobileConnect(walletWindow, "mainnet-beta");
    const connectUrl = new URL(assignedUrl);
    assert.equal(connectUrl.origin, "https://phantom.com");
    assert.equal(connectUrl.pathname, "/ul/v1/connect");
    assert.equal(connectUrl.searchParams.get("cluster"), "mainnet-beta");
    const pendingState = JSON.parse(storage.get("fluxgrid.phantom.deeplink.v1"));
    const phantomKeys = nacl.box.keyPair();
    const sharedSecret = nacl.box.before(
        decodeWalletBytes(connectUrl.searchParams.get("dapp_encryption_public_key")),
        phantomKeys.secretKey
    );
    const connectNonce = nacl.randomBytes(nacl.box.nonceLength);
    const connectData = nacl.box.after(
        new TextEncoder().encode(JSON.stringify({
            public_key: "mobile-wallet-address",
            session: "phantom-session-token"
        })),
        connectNonce,
        sharedSecret
    );
    const connectCallback = new URL(connectUrl.searchParams.get("redirect_link"));
    connectCallback.searchParams.set("phantom_encryption_public_key", encodeWalletBytes(phantomKeys.publicKey));
    connectCallback.searchParams.set("nonce", encodeWalletBytes(connectNonce));
    connectCallback.searchParams.set("data", encodeWalletBytes(connectData));
    walletWindow.location.href = connectCallback.toString();

    const callback = readPhantomMobileCallback(walletWindow);
    const decrypted = decryptPhantomMobileResponse(walletWindow, pendingState, callback.response, true);
    assert.equal(decrypted.data.public_key, "mobile-wallet-address");
    assert.equal(decrypted.data.session, "phantom-session-token");
    savePhantomMobileSession(walletWindow, pendingState, {
        walletAddress: decrypted.data.public_key,
        session: decrypted.data.session,
        sharedSecret: decrypted.sharedSecret,
        phantomPublicKey: decrypted.phantomPublicKey
    });
    const connection = await connectPhantom(walletWindow);
    assert.equal(connection.publicKey, "mobile-wallet-address");
    assert.equal(getConnectedPhantomWallet(walletWindow).provider, connection.provider);

    const signRequest = connection.provider.signMessage(new TextEncoder().encode("RelicGrid ownership challenge"));
    void signRequest;
    const signUrl = new URL(assignedUrl);
    assert.equal(signUrl.pathname, "/ul/v1/signMessage");
    const signPayload = nacl.box.open.after(
        decodeWalletBytes(signUrl.searchParams.get("payload")),
        decodeWalletBytes(signUrl.searchParams.get("nonce")),
        sharedSecret
    );
    const parsedPayload = JSON.parse(new TextDecoder().decode(signPayload));
    assert.equal(
        new TextDecoder().decode(decodeWalletBytes(parsedPayload.message)),
        "RelicGrid ownership challenge"
    );
    assert.equal(parsedPayload.session, "phantom-session-token");
    assert.equal(JSON.parse(storage.get("fluxgrid.phantom.deeplink.v1")).action, "wallet-link-sign");

    const paymentIntentId = "8f9ef883-520e-45ef-96ae-62e621d3b31c";
    void connection.provider.sendTransaction(
        { serialize: () => Uint8Array.from([8, 9, 10]) },
        null,
        {
            chain: "mainnet-beta",
            paymentIntentId,
            paymentIntentAmountRaw: "125000000",
            paymentIntentExpiresAt: "2030-01-01T00:15:00.000Z",
            blockhashRetryCount: 0
        }
    );
    const depositUrl = new URL(assignedUrl);
    assert.equal(depositUrl.pathname, "/ul/v1/signTransaction");
    const depositState = JSON.parse(storage.get("fluxgrid.phantom.deeplink.v1"));
    assert.equal(depositState.action, "deposit-sign");
    assert.equal(depositState.contextSlot, undefined);
    assert.equal(depositState.paymentIntentId, paymentIntentId);
    assert.equal(depositState.paymentIntentAmountRaw, "125000000");
    assert.equal(depositState.paymentIntentExpiresAt, "2030-01-01T00:15:00.000Z");
    assert.equal(depositState.blockhashRetryCount, 0);
    const depositPayload = nacl.box.open.after(
        decodeWalletBytes(depositUrl.searchParams.get("payload")),
        decodeWalletBytes(depositUrl.searchParams.get("nonce")),
        sharedSecret
    );
    const parsedDepositPayload = JSON.parse(new TextDecoder().decode(depositPayload));
    assert.deepEqual(decodeWalletBytes(parsedDepositPayload.transaction), Uint8Array.from([8, 9, 10]));

    const freshTransactionBytes = Uint8Array.from([11, 12, 13, 14]);
    void connection.provider.sendTransaction(
        { serialize: () => freshTransactionBytes },
        null,
        {
            chain: "mainnet-beta",
            paymentIntentId,
            paymentIntentAmountRaw: "125000000",
            paymentIntentExpiresAt: "2030-01-01T00:15:00.000Z",
            blockhashRetryCount: 1
        }
    );
    const refreshedDepositUrl = new URL(assignedUrl);
    const refreshedState = JSON.parse(storage.get("fluxgrid.phantom.deeplink.v1"));
    const refreshedPayload = nacl.box.open.after(
        decodeWalletBytes(refreshedDepositUrl.searchParams.get("payload")),
        decodeWalletBytes(refreshedDepositUrl.searchParams.get("nonce")),
        sharedSecret
    );
    assert.equal(refreshedState.blockhashRetryCount, 1);
    assert.equal(refreshedState.paymentIntentId, paymentIntentId);
    assert.deepEqual(
        decodeWalletBytes(JSON.parse(new TextDecoder().decode(refreshedPayload)).transaction),
        freshTransactionBytes
    );
});

test("mobile browser detection recognizes phones and touch-enabled iPads", () => {
    assert.equal(isMobileBrowser({ userAgent: "Mozilla/5.0 (iPhone)", platform: "iPhone", maxTouchPoints: 1 }), true);
    assert.equal(isMobileBrowser({ userAgent: "Mozilla/5.0 (Linux; Android 14)", platform: "Linux", maxTouchPoints: 1 }), true);
    assert.equal(isMobileBrowser({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 }), true);
    assert.equal(isMobileBrowser({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", maxTouchPoints: 0 }), false);
});

test("Phantom mobile browse link opens the secure current page and rejects insecure URLs", () => {
    const browseUrl = new URL(createPhantomBrowseUrl("https://cyfur-game-mu.vercel.app/?ignored=1"));
    assert.equal(browseUrl.origin, "https://phantom.com");
    assert.equal(browseUrl.pathname, `/ul/browse/${encodeURIComponent("https://cyfur-game-mu.vercel.app/?ignored=1&phantom_handoff=1")}`);
    assert.equal(browseUrl.searchParams.get("ref"), "https://cyfur-game-mu.vercel.app");
    assert.throws(() => createPhantomBrowseUrl("http://example.com"), /secure HTTPS/);
});

test("Level 1 economy keeps star ratings separate from credit amounts", () => {
    assert.equal(CYFUR_CREDITS_PER_TOKEN, 10000);
    assert.equal(apiCreditsPerToken, CYFUR_CREDITS_PER_TOKEN);
    assert.deepEqual(getLevelEconomy(1), {
        entryCostCredits: 100,
        threeStarPayoutCredits: 160,
        twoStarRefundCredits: 40,
        oneStarPayoutCredits: 0
    });
});

test("wallet API publishes the same exchange rate and keeps deposits disabled", async () => {
    const envNames = [
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SOLANA_NETWORK",
        "SOLANA_RPC_URL",
        "WALLET_DIRECT_TREASURY_READY",
        "WALLET_DEPOSITS_ENABLED",
        "WALLET_MAINNET_DEPOSITS_ENABLED"
    ];
    const previousEnvironment = Object.fromEntries(
        envNames.map((name) => [name, process.env[name]])
    );
    for (const name of envNames) delete process.env[name];
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "public-test-key";
    const originalFetch = globalThis.fetch;
    const requestedUrls = [];
    globalThis.fetch = async (url) => {
        const target = String(url);
        requestedUrls.push(target);
        if (target.includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
        }
        if (target.includes("/wallet_credit_accounts?")) {
            return new Response(JSON.stringify([{ balance_credits: "250" }]), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
        const walletEndpoint = require("../api/wallet.js");
        const response = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await walletEndpoint({
            method: "GET",
            headers: { authorization: "Bearer test-token" }
        }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.exchangeRateCreditsPerToken, CYFUR_CREDITS_PER_TOKEN);
        assert.equal(response.payload.depositsEnabled, false);
        assert.equal(response.payload.paidGameplayEnabled, false);
        assert.equal(response.payload.fundingStatus, "disabled");
        assert.equal(response.payload.disabledReason, "direct_treasury_setup_incomplete");
        assert.equal(response.payload.treasuryAddress, null);
        assert.equal(response.payload.linkedWalletAddress, null);
        assert.equal(requestedUrls.some((target) => target.includes("player_solana_wallets")), false);
        assert.equal(Object.hasOwn(response.payload, "readinessChecks"), false);
        assert.doesNotMatch(response.payload.disabledMessage, /SOLANA_|SUPABASE_|wallet_system_config|Vercel|Supabase/);
        assert.match(response.payload.disabledMessage, /Do not send CYFUR/);
        assert.equal(response.payload.balanceCredits, "250");
        assert.equal(response.payload.balanceVerified, true);
    } finally {
        globalThis.fetch = originalFetch;
        for (const [name, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test("backend level entry costs match the campaign economy for all 99 levels", () => {
    for (let level = 1; level <= 99; level++) {
        assert.equal(getLevelEntryCostCredits(level), getLevelEconomy(level).entryCostCredits);
    }
    assert.equal(getLevelEntryCostCredits(0), null);
    assert.equal(getLevelEntryCostCredits(100), null);
});

test("free gameplay testing does not request paid level entry or change wallet credits", () => {
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    const startIndex = app.indexOf("async function startLevel");
    const endIndex = app.indexOf("\nfunction leaveGameplay", startIndex);
    const startLevel = app.slice(startIndex, endIndex);
    assert.ok(startIndex >= 0);
    assert.ok(endIndex > startIndex);
    assert.doesNotMatch(startLevel, /requestLevelEntry/);
    assert.match(startLevel, /activeWalletLevelSessionId = null/);
    assert.match(app, /entryCost\.textContent = "FREE PLAY"/);

    const scene = readFileSync(new URL("../script.js", import.meta.url), "utf8");
    assert.match(scene, /reward\.textContent = "0 credits"/);
    assert.match(scene, /Testing mode · no credits changed/);
    assert.match(scene, /const mirror = placedMirrors\.get\(gridKey\(row, col\)\);[\s\S]*?else if \(isObstacle\)/);
    assert.match(scene, /crystal\.definition\.inputColor !== colorIndex % beamColors\.length/);
    assert.match(scene, /drawActiveRoute\(previewRoute, previewRoute\.segments\.length, true\)/);
    assert.doesNotMatch(
        scene.slice(scene.indexOf("function placeOrRotateMirror"), scene.indexOf("function toggleLaunchDirection")),
        /That tile is blocked by a structure/
    );
});

test("RelicGrid branding is used in the game and hidden scenes stop rendering", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /<title>RelicGrid/);
    assert.doesNotMatch(html, /FluxGrid/i);

    const scene = readFileSync(new URL("../script.js", import.meta.url), "utf8");
    assert.match(scene, /antialias: true/);
    assert.match(scene, /mobileQuality \? 1\.25 : 1\.5/);
    assert.match(scene, /configureQualityLight/);
    assert.match(scene, /new THREE\.Sprite\(new THREE\.SpriteMaterial/);
    assert.match(scene, /crystalHits\.forEach/);
    assert.match(scene, /if \(document\.hidden \|\| canvas\.clientWidth === 0 \|\| canvas\.clientHeight === 0\) return;/);
    assert.match(scene, /cancelAnimationFrame\(renderRequest\)/);
    assert.match(scene, /const coreScale = 0\.36/);
    assert.match(scene, /gridX\(GRID\.target\.col\) - 1\.35 \* coreScale/);
    assert.match(scene, /gridZ\(GRID\.target\.row\) - 0\.1 \* coreScale/);
    assert.match(scene, /playSoundEffect\("mirror"\)/);
    assert.match(scene, /playSoundEffect\("core"\)/);
    assert.match(scene, /playSoundEffect\("completion"\)/);
    assert.match(scene, /activationRingMaterials\.forEach/);
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    assert.match(app, /next-level[\s\S]*?startLevel\(number, true\)/);
    assert.doesNotMatch(app, /playLevelTransition|transitionFor/);
    assert.match(app, /videoAction\.textContent = "Play Now  →"/);
    assert.match(app, /transitionVideo\.onended = \(\) => \{[\s\S]*?showNameOrHome\(\);/);
    assert.doesNotMatch(app, /videoAction\.textContent = "CONTINUE  →"/);
    assert.match(html, /id="video-action-button"[^>]*>Play Now/);
    assert.doesNotMatch(app, /Tap to play the opening transmission with sound/);
    assert.match(html, /id="intro-video"[^>]+src="intro\.mp4"/);
    const styles = readFileSync(new URL("../style.css", import.meta.url), "utf8");
    assert.match(styles, /video-action \.button \{[\s\S]*?font-size: clamp\(17px, 4vw, 20px\)/);
});

test("deposit UI does not require a connected wallet and exposes memo-confirm verification", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /FUND YOUR RELICGRID ACCOUNT/);
    assert.match(html, /at least 1 CYFUR/);
    assert.match(html, /id="wallet-address">Loading verified treasury…<\/code>/);
    assert.match(html, /id="wallet-copy-address"/);
    assert.match(html, /id="deposit-required-memo"/);
    assert.match(html, /COPY MEMO/);
    assert.match(html, /VERIFY PAYMENT/);
    assert.match(html, /Paste signature or Solana Explorer\/Solscan link/);
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    assert.match(app, /fetchWithTimeout\(apiUrl\("payment-intent"\)/);
    assert.match(app, /Unavailable: \$\{readinessMessage\}/);
    assert.match(app, /typeof result\.disabledMessage === "string"/);
    assert.doesNotMatch(app, /SOLANA_TREASURY_ADDRESS must exactly match Supabase treasury_address/);
    assert.doesNotMatch(app, /wallet_system_config\.deposits_enabled/);
    assert.match(app, /Deposits are temporarily unavailable\. Please check back later\./);
    assert.doesNotMatch(html, /id="wallet-transfer-amount"|id="wallet-transfer-form"|id="wallet-preflight-button"/);
    assert.doesNotMatch(html, /CONNECT SOLANA WALLET|CONNECT LINKED WALLET/);
    assert.match(app, /async function createCyfurDepositInstructions/);
    assert.match(app, /address\.textContent = result\.treasuryAddress \|\| "Treasury unavailable"/);
    assert.match(app, /relicgrid\.payment-intent\.v1/);
    assert.match(app, /body: JSON\.stringify\(\{ signature: signatureOrLink \}\)/);
    assert.doesNotMatch(app, /body: JSON\.stringify\(\{ signature: signatureOrLink, paymentIntentId \}\)/);
    assert.match(app, /Deposit not detected yet\. Please wait and check again/);
});

test("deposit backend pins the approved treasury and migration keeps deposits disabled", () => {
    const treasury = "BQa1gxbBP2jNJEzyHHtMAUfJepXjTnqQEhBuojL9E3ts";
    const mint = "9F4hLLngEAhepsH2HLTH6kBYmmq6dzm4GXRrcpME3uam";
    assert.equal(RELICGRID_CYFUR_MINT_ADDRESS, mint);
    const mintAccount = {
        value: {
            owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            data: { parsed: { type: "mint", info: {
                decimals: 8,
                mintAuthority: null,
                freezeAuthority: null
            } } }
        }
    };
    assert.equal(isOfficialCyfurMintAccount(mintAccount), true);
    assert.equal(isOfficialCyfurMintAccount({
        value: {
            ...mintAccount.value,
            data: { parsed: { type: "mint", info: { ...mintAccount.value.data.parsed.info, freezeAuthority: treasury } } }
        }
    }), false);
    const verifier = readFileSync(new URL("../server/lib/solana-deposit.js", import.meta.url), "utf8");
    const migration = readFileSync(new URL("../supabase-relicgrid-treasury.sql", import.meta.url), "utf8");
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    assert.match(verifier, new RegExp(`RELICGRID_TREASURY_ADDRESS = "${treasury}"`));
    assert.match(verifier, new RegExp(`RELICGRID_CYFUR_MINT_ADDRESS = "${mint}"`));
    assert.match(migration, new RegExp(`treasury_address = '${treasury}'`));
    assert.match(migration, /deposits_enabled = false/);
    assert.match(migration, /paid_gameplay_enabled = false/);
    for (const apiFile of ["wallet.js", "payment-intent.js", "deposits.js", "deposit-transaction.js"]) {
        const api = readFileSync(new URL(`../api/${apiFile}`, import.meta.url), "utf8");
        assert.match(api, /RELICGRID_TREASURY_ADDRESS/);
        assert.match(api, /RELICGRID_CYFUR_MINT_ADDRESS/);
        assert.doesNotMatch(api, /SOLANA_TREASURY_ADDRESS/);
    }
    const paymentIntentApi = readFileSync(new URL("../api/payment-intent.js", import.meta.url), "utf8");
    assert.match(paymentIntentApi, /WALLET_DIRECT_TREASURY_READY must be true/);
    assert.match(paymentIntentApi, /WALLET_DEPOSITS_ENABLED must be true/);
    assert.match(paymentIntentApi, /WALLET_MAINNET_DEPOSITS_ENABLED must be true for mainnet/);
    assert.doesNotMatch(app, new RegExp(treasury));
    assert.doesNotMatch(html, new RegExp(treasury));
    assert.doesNotMatch(paymentIntentApi, /readinessChecks,/);
});

test("wallet API returns verified zero for a player with no credit account or ledger entries", async () => {
    const previousEnvironment = {
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
    };
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "public-test-key";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const target = String(url);
        if (target.includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "empty-player" }), { status: 200 });
        }
        if (target.includes("/wallet_credit_accounts?") ||
            target.includes("/wallet_deposits?") ||
            target.includes("/wallet_credit_ledger?")) {
            return new Response("[]", { status: 200 });
        }
        throw new Error(`Unexpected wallet balance request: ${target}`);
    };
    try {
        const endpoint = require("../api/wallet.js");
        const response = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "GET",
            headers: { authorization: "Bearer player-session" }
        }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.balanceCredits, "0");
        assert.equal(response.payload.balanceVerified, true);
        assert.equal(response.payload.depositsEnabled, false);
    } finally {
        globalThis.fetch = originalFetch;
        for (const [name, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test("all campaign levels are selectable and the in-game field guide is available", () => {
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    const levelPicker = app.slice(app.indexOf("function renderLevels"), app.indexOf("\nfunction renderHome"));
    const startLevel = app.slice(app.indexOf("async function startLevel"), app.indexOf("\nfunction leaveGameplay"));
    assert.match(levelPicker, /className = `level-card is-unlocked/);
    assert.doesNotMatch(levelPicker, /button\.disabled\s*=/);
    assert.doesNotMatch(startLevel, /number > player\.unlockedLevel/);

    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /id="game-guide-toggle"/);
    assert.match(html, /id="game-guide"/);
    assert.match(html, /Charge crystals in order/);
    assert.match(html, /LIVE TUTORIAL/);
    assert.match(app, /game-guide-close/);
    const scene = readFileSync(new URL("../script.js", import.meta.url), "utf8");
    assert.match(scene, /tutorialTargetMarker/);
    assert.match(scene, /drawActiveRoute\(previewRoute, previewRoute\.segments\.length, true\)/);
    assert.match(scene, /firstLevelTutorialStage = "complete"/);
    assert.match(scene, /Rotate to redirect/);
});

test("deposit conversion uses precise integer arithmetic and requires explicit rounding", () => {
    assert.equal(getDepositCreditAmount("100000000", 8, "reject_fraction"), "10000");
    assert.equal(getDepositCreditAmount("10000", 8, "reject_fraction"), "1");
    assert.throws(
        () => getDepositCreditAmount("1", 8, "reject_fraction"),
        /whole number of credits/
    );
    assert.throws(() => getDepositCreditAmount("1", 8, "floor"), /outside the supported range/);
    assert.equal(getDepositCreditAmount("5000", 8, "nearest"), "1");
    assert.throws(() => getDepositCreditAmount("1", 8, null), /rounding policy/);
    assert.throws(() => getDepositCreditAmount("1.5", 8, "floor"), /positive integer string/);
    assert.throws(() => getDepositCreditAmount("1", 19, "floor"), /Token decimals/);
});

test("wallet deposit migration keeps processing disabled and credits atomically", () => {
    const migration = readFileSync(new URL("../supabase-wallet-deposit-processing.sql", import.meta.url), "utf8");
    assert.match(migration, /rounding_policy = 'floor'[\s\S]*?deposits_enabled = false/);
    assert.match(migration, /create or replace function public\.process_verified_wallet_deposit/);
    assert.match(migration, /on conflict \(network, transaction_signature\) do nothing/i);
    assert.match(migration, /public\.apply_wallet_ledger_entry/);
    assert.match(migration, /grant execute[\s\S]*?to service_role/i);
    assert.match(migration, /from public, anon, authenticated/i);
});

test("direct treasury migration leaves payment switches disabled and keeps credits atomic", () => {
    const migration = readFileSync(new URL("../supabase-direct-treasury-deposits.sql", import.meta.url), "utf8");
    assert.match(migration, /deposits_enabled = false/);
    assert.match(migration, /paid_gameplay_enabled = false/);
    assert.match(migration, /create table if not exists public\.player_solana_wallets/);
    assert.match(migration, /create table if not exists public\.wallet_link_challenges/);
    assert.match(migration, /create or replace function public\.link_player_solana_wallet/);
    assert.match(migration, /expires_at > now\(\)/);
    assert.match(migration, /create or replace function public\.process_verified_treasury_deposit/);
    assert.match(migration, /v_config\.treasury_address is distinct from p_deposit_address/);
    assert.doesNotMatch(migration, /Source wallet is not linked to this player/);
    assert.match(migration, /on conflict \(network, transaction_signature\) do nothing/i);
    assert.match(migration, /public\.apply_wallet_ledger_entry/);
    assert.match(migration, /to service_role/i);
});

test("wallet-less deposit migration allows unlinked senders without weakening atomic verification", () => {
    const migration = readFileSync(new URL("../supabase-walletless-deposits.sql", import.meta.url), "utf8");
    assert.match(migration, /alter column source_wallet_address drop not null/i);
    assert.match(migration, /where status = 'pending'/i);
    assert.match(migration, /v_intent\.source_wallet_address is not null[\s\S]*?v_intent\.source_wallet_address <> p_source_wallet_address/i);
    assert.doesNotMatch(migration, /from public\.player_solana_wallets/);
    assert.match(migration, /on conflict \(network, transaction_signature\) do nothing/i);
    assert.match(migration, /public\.apply_wallet_ledger_entry/);
    assert.match(migration, /revoke all on function public\.process_verified_payment_intent/i);
    assert.match(migration, /grant execute[\s\S]*?to service_role/i);
});

test("wallet ownership proof verifies Ed25519 signatures and rejects altered messages", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const walletAddress = encodeBase58(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const challenge = "RelicGrid Solana wallet ownership proof\nNonce: test";
    const signature = signMessage(null, Buffer.from(challenge), privateKey).toString("base64");
    assert.equal(verifyWalletSignature(walletAddress, challenge, signature), true);
    assert.equal(verifyWalletSignature(walletAddress, `${challenge}\nchanged`, signature), false);
    assert.equal(verifyWalletSignature(walletAddress, challenge, "invalid"), false);
});

test("wallet-link API validates the configured cluster and fee-payer account before linking", async () => {
    const envNames = [
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SOLANA_RPC_URL",
        "SOLANA_NETWORK"
    ];
    const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "public-test-key",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-test-key",
        SOLANA_RPC_URL: "https://mainnet.example/rpc",
        SOLANA_NETWORK: "mainnet-beta"
    });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const walletAddress = encodeBase58(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const existingWrappedSolAccount = "FWc2DZyCf4dCwJXRavjNxssuz4ppPhd3ie1Tvb36jYs7";
    const originalFetch = globalThis.fetch;
    let storedChallenge;
    let linkedWallet = existingWrappedSolAccount;
    let accountOwner = "11111111111111111111111111111111";
    let rpcGenesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    const rpcCalls = [];
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
        }
        if (target === process.env.SOLANA_RPC_URL) {
            const call = JSON.parse(options.body);
            rpcCalls.push(call);
            const result = call.method === "getGenesisHash"
                ? rpcGenesisHash
                : call.method === "getAccountInfo"
                    ? { value: { owner: accountOwner, lamports: 1000000, data: ["", "base64"] } }
                    : null;
            return new Response(JSON.stringify({ result }), { status: 200 });
        }
        if (target.includes("wallet_link_challenges?on_conflict=player_id")) {
            storedChallenge = JSON.parse(options.body);
            return new Response(null, { status: 204 });
        }
        if (target.includes("wallet_link_challenges?select=")) {
            return new Response(JSON.stringify([{
                challenge: storedChallenge.challenge,
                expires_at: storedChallenge.expires_at
            }]), { status: 200 });
        }
        if (target.includes("/rpc/link_player_solana_wallet")) {
            linkedWallet = JSON.parse(options.body);
            return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected wallet-link request: ${target}`);
    };
    function makeResponse() {
        return {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
    }

    try {
        const endpoint = require("../api/wallet-link.js");
        const headers = { authorization: "Bearer test-access-token" };
        const challengeResponse = makeResponse();
        await endpoint({
            method: "POST",
            headers,
            body: { action: "challenge", walletAddress }
        }, challengeResponse);
        assert.equal(challengeResponse.statusCode, 200);
        assert.equal(typeof challengeResponse.payload.challenge, "string");
        assert.equal(rpcCalls.length, 0);

        const signature = signMessage(
            null,
            Buffer.from(challengeResponse.payload.challenge),
            privateKey
        ).toString("base64");
        const verifyResponse = makeResponse();
        await endpoint({
            method: "POST",
            headers,
            body: { action: "verify", walletAddress, signature }
        }, verifyResponse);
        assert.equal(verifyResponse.statusCode, 200);
        assert.deepEqual(verifyResponse.payload, { linked: true, walletAddress });
        assert.equal(linkedWallet.p_wallet_address, walletAddress);
        assert.equal(linkedWallet.p_player_id, "test-player");
        assert.equal(linkedWallet.p_challenge, challengeResponse.payload.challenge);
        assert.deepEqual(rpcCalls.map((call) => call.method), [
            "getGenesisHash",
            "getAccountInfo"
        ]);
        assert.equal(rpcCalls[1].params[0], walletAddress);
        assert.deepEqual(rpcCalls[1].params[1], {
            commitment: "confirmed",
            encoding: "base64"
        });

        rpcGenesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
        const wrongClusterChallenge = makeResponse();
        await endpoint({
            method: "POST",
            headers,
            body: { action: "challenge", walletAddress }
        }, wrongClusterChallenge);
        const wrongClusterSignature = signMessage(
            null,
            Buffer.from(wrongClusterChallenge.payload.challenge),
            privateKey
        ).toString("base64");
        const linkedWalletBeforeWrongCluster = linkedWallet;
        const wrongClusterResponse = makeResponse();
        await endpoint({
            method: "POST",
            headers,
            body: { action: "verify", walletAddress, signature: wrongClusterSignature }
        }, wrongClusterResponse);
        assert.equal(wrongClusterResponse.statusCode, 503);
        assert.equal(wrongClusterResponse.payload.error, "solana_rpc_network_mismatch");
        assert.equal(linkedWallet, linkedWalletBeforeWrongCluster);

        rpcGenesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
        accountOwner = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        const rejectedChallenge = makeResponse();
        await endpoint({
            method: "POST",
            headers,
            body: { action: "challenge", walletAddress }
        }, rejectedChallenge);
        const rejectedSignature = signMessage(
            null,
            Buffer.from(rejectedChallenge.payload.challenge),
            privateKey
        ).toString("base64");
        const linkCountBeforeRejectedWallet = linkedWallet;
        const rejectedLink = makeResponse();
        await endpoint({
            method: "POST",
            headers,
            body: { action: "verify", walletAddress, signature: rejectedSignature }
        }, rejectedLink);
        assert.equal(rejectedLink.statusCode, 409);
        assert.equal(rejectedLink.payload.error, "wallet_not_valid_fee_payer");
        assert.equal(linkedWallet, linkCountBeforeRejectedWallet);
        assert.equal(rpcCalls.at(-1).params[0], walletAddress);
    } finally {
        globalThis.fetch = originalFetch;
        for (const name of envNames) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    }
});

test("server proof validator accepts the generated solution and rejects fabricated routes", () => {
    for (const level of levels) {
        const solution = level.solutionMirrors.map(({ row, col, orientation }) => ({
            row,
            col,
            slash: orientation === "/"
        }));
        assert.deepEqual(
            verifyLevelProof(level, solution, level.start.direction),
            { connected: true, reflections: level.par },
            `Level ${level.number} solution must reach its battery.`
        );
    }
    assert.equal(verifyLevelProof(levels[0], [], levels[0].start.direction).connected, false);
    assert.equal(verifyLevelProof(levels[0], [{ row: -1, col: 1, slash: true }], 1).connected, false);
    assert.equal(verifyLevelProof(levels[0], [], 0).connected, false);
});

test("server proof requires every crystal to be hit in the correct color sequence", () => {
    const level = levels[0];
    const mirrors = level.solutionMirrors.map(({ row, col, orientation }) => ({
        row,
        col,
        slash: orientation === "/"
    }));
    const routeCells = new Set(level.route.map(({ row, col }) => `${row},${col}`));
    const obstacles = new Set(level.obstacles.map(({ row, col }) => `${row},${col}`));
    const openCell = Array.from({ length: 6 }, (_, row) =>
        Array.from({ length: 8 }, (_, col) => ({ row, col }))
    ).flat().find(({ row, col }) => {
        const key = `${row},${col}`;
        return !routeCells.has(key) && !obstacles.has(key);
    });

    assert.ok(level.crystals.length >= 1);
    assert.deepEqual(
        verifyLevelProof(level, mirrors, level.start.direction),
        { connected: true, reflections: level.par }
    );
    assert.equal(
        verifyLevelProof({
            ...level,
            crystals: [{ ...level.crystals[0], ...openCell }, ...level.crystals.slice(1)]
        }, mirrors, level.start.direction).reason,
        "crystal_missed"
    );
    assert.equal(
        verifyLevelProof({
            ...level,
            crystals: [{
                ...level.crystals[0],
                inputColor: (level.crystals[0].inputColor + 1) % 3
            }, ...level.crystals.slice(1)]
        }, mirrors, level.start.direction).reason,
        "crystal_mismatch"
    );
    assert.equal(
        verifyLevelProof(level, [
            ...mirrors,
            { row: level.crystals[0].row, col: level.crystals[0].col, slash: true }
        ], level.start.direction).reason,
        "invalid_mirror_position"
    );
});

test("server-side time ratings share the configured thresholds and exact reward formulas", async () => {
    for (const level of levels) {
        const three = await getLevelEconomyAndStars(
            level.number,
            level.starTimeTargets.threeSeconds * 1000
        );
        const two = await getLevelEconomyAndStars(
            level.number,
            level.starTimeTargets.twoSeconds * 1000
        );
        const one = await getLevelEconomyAndStars(
            level.number,
            (level.starTimeTargets.twoSeconds + 1) * 1000
        );
        assert.equal(three.result.stars, 3);
        assert.equal(three.result.rewardCredits, level.economy.threeStarPayoutCredits);
        assert.equal(two.result.stars, 2);
        assert.equal(two.result.rewardCredits, level.economy.twoStarRefundCredits);
        assert.equal(one.result.stars, 1);
        assert.equal(one.result.rewardCredits, 0);
    }
});

test("level completion API derives the reward from server time and returns duplicates without a second award", async () => {
    const envNames = [
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY"
    ];
    const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    for (const name of envNames) process.env[name] = `test-${name.toLowerCase()}`;
    process.env.SUPABASE_URL = "https://example.supabase.co";
    const originalFetch = globalThis.fetch;
    const level = levels[0];
    const mirrors = level.solutionMirrors.map(({ row, col, orientation }) => ({
        row,
        col,
        slash: orientation === "/"
    }));
    let completedAt = null;
    let rpcPayload;
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
        }
        if (target.includes("/wallet_level_sessions?")) {
            return new Response(JSON.stringify([{
                id: "123e4567-e89b-42d3-a456-426614174000",
                player_id: "test-player",
                level_number: 1,
                timer_started_at: new Date(Date.now() - 1000).toISOString(),
                expires_at: new Date(Date.now() + 60000).toISOString(),
                completed_at: completedAt
            }]), { status: 200 });
        }
        if (target.includes("/rpc/complete_wallet_level")) {
            rpcPayload = JSON.parse(options.body);
            return new Response(JSON.stringify([{
                balance_credits: "160",
                stars: rpcPayload.p_stars,
                reward_credits: rpcPayload.p_reward_credits,
                elapsed_milliseconds: rpcPayload.p_elapsed_milliseconds,
                already_completed: false
            }]), { status: 200 });
        }
        throw new Error(`Unexpected test request: ${target}`);
    };

    const makeResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        setHeader() {},
        json(payload) { this.payload = payload; }
    });

    try {
        const completionEndpoint = require("../api/level-completion.js");
        const response = makeResponse();
        await completionEndpoint({
            method: "POST",
            headers: { authorization: "Bearer test-access-token" },
            body: {
                sessionId: "123e4567-e89b-42d3-a456-426614174000",
                mirrors,
                launchDirection: level.start.direction,
                stars: 1,
                elapsedMilliseconds: 999999
            }
        }, response);

        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.stars, 3);
        assert.equal(response.payload.rewardCredits, "160");
        assert.equal(rpcPayload.p_stars, 3);
        assert.equal(rpcPayload.p_reward_credits, 160);
        assert.ok(rpcPayload.p_elapsed_milliseconds < 35000);
        assert.equal("stars" in response.payload, true);

        completedAt = new Date().toISOString();
        const duplicateResponse = makeResponse();
        globalThis.fetch = async (url, options = {}) => {
            const target = String(url);
            if (target.includes("/auth/v1/user")) {
                return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
            }
            if (target.includes("/wallet_level_sessions?")) {
                return new Response(JSON.stringify([{
                    id: "123e4567-e89b-42d3-a456-426614174000",
                    player_id: "test-player",
                    level_number: 1,
                    timer_started_at: new Date(Date.now() - 1000).toISOString(),
                    expires_at: new Date(Date.now() + 60000).toISOString(),
                    completed_at: completedAt
                }]), { status: 200 });
            }
            if (target.includes("/rpc/complete_wallet_level")) {
                const duplicatePayload = JSON.parse(options.body);
                assert.equal(duplicatePayload.p_stars, 1);
                assert.equal(duplicatePayload.p_reward_credits, 0);
                return new Response(JSON.stringify([{
                    balance_credits: "160",
                    stars: 3,
                    reward_credits: 160,
                    elapsed_milliseconds: 1000,
                    already_completed: true
                }]), { status: 200 });
            }
            throw new Error(`Unexpected duplicate test request: ${target}`);
        };
        await completionEndpoint({
            method: "POST",
            headers: { authorization: "Bearer test-access-token" },
            body: {
                sessionId: "123e4567-e89b-42d3-a456-426614174000",
                mirrors,
                launchDirection: level.start.direction
            }
        }, duplicateResponse);

        assert.equal(duplicateResponse.statusCode, 200);
        assert.equal(duplicateResponse.payload.duplicate, true);
        assert.equal(duplicateResponse.payload.rewardCredits, "160");
    } finally {
        globalThis.fetch = originalFetch;
        for (const name of envNames) {
            if (previousEnv[name] === undefined) delete process.env[name];
            else process.env[name] = previousEnv[name];
        }
    }
});

test("paid gameplay migration stays disabled and makes entry and reward operations atomic", () => {
    const migration = readFileSync(new URL("../supabase-wallet-deposit-processing.sql", import.meta.url), "utf8");
    assert.match(migration, /paid_gameplay_enabled boolean not null default false/);
    assert.match(migration, /paid_gameplay_enabled = false/);
    assert.match(migration, /create table if not exists public\.wallet_level_sessions/);
    assert.match(migration, /create or replace function public\.start_wallet_level\(/);
    assert.match(migration, /wallet_level_sessions_player_request_idx/);
    assert.match(migration, /entry_request_id/);
    assert.match(migration, /create or replace function public\.start_wallet_level_timer\(/);
    assert.match(migration, /create or replace function public\.complete_wallet_level\(/);
    assert.match(migration, /for update/);
    assert.match(migration, /level-entry:' \|\| v_level_session::text/);
    assert.match(migration, /level-reward:' \|\| p_session_id::text/);
    assert.match(migration, /repeat reward prevented|v_first_completion/);
    assert.match(migration, /paid level completions must use the server-verified completion endpoint/i);
});

test("Solana verifier credits only successful finalized transfers to the mapped token owner", async () => {
    const signature = "1".repeat(64);
    const depositAddress = "11111111111111111111111111111111";
    const officialMint = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const tokenProgramId = officialMint;
    const tokenAccount = "So11111111111111111111111111111111111111112";
    const sourceWallet = "11111111111111111111111111111111";
    const sourceTokenAccount = "Stake11111111111111111111111111111111111111";
    let transaction = {
        slot: 500,
        blockTime: 1700000000,
        transaction: {
            signatures: [signature],
            message: {
                accountKeys: [
                    { pubkey: sourceWallet, signer: true },
                    sourceTokenAccount,
                    tokenAccount
                ],
                instructions: [{
                    programId: tokenProgramId,
                    parsed: {
                        type: "transferChecked",
                        info: {
                            mint: officialMint,
                            source: sourceTokenAccount,
                            destination: tokenAccount,
                            authority: sourceWallet,
                            tokenAmount: { amount: "10000" }
                        }
                    }
                }]
            }
        },
        meta: {
            err: null,
            preTokenBalances: [{
                accountIndex: 1,
                mint: officialMint,
                owner: sourceWallet,
                uiTokenAmount: { amount: "20000" }
            }],
            postTokenBalances: [
                {
                    accountIndex: 2,
                    mint: officialMint,
                    owner: depositAddress,
                    uiTokenAmount: { amount: "10000" }
                },
                {
                    accountIndex: 1,
                    mint: officialMint,
                    owner: sourceWallet,
                    uiTokenAmount: { amount: "10000" }
                }
            ]
        }
    };
    let status = { err: null, confirmationStatus: "finalized" };
    const fakeFetch = async (_url, options) => {
        const call = JSON.parse(options.body);
        const { method } = call;
        const result = method === "getGenesisHash"
            ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
            : method === "getSignatureStatuses"
                ? { value: [status] }
                : method === "getTransaction"
                    ? transaction
                    : call.params[0] === depositAddress
                        ? { value: { owner: "11111111111111111111111111111111", data: ["", "base64"] } }
                        : call.params[0] === tokenAccount
                            ? { value: { owner: tokenProgramId, data: { parsed: { type: "account", info: { mint: officialMint, owner: depositAddress } } } } }
                            : { value: { owner: tokenProgramId, data: { parsed: { type: "mint", info: {
                                decimals: 8,
                                mintAuthority: null,
                                freezeAuthority: null
                            } } } } };
        return new Response(JSON.stringify({ result }), { status: 200 });
    };
    const options = {
        signature,
        depositAddress,
        depositTokenAccount: tokenAccount,
        officialMint,
        tokenProgramId,
        tokenDecimals: 8,
        network: "devnet",
        rpcUrl: "https://solana.example/rpc",
        fetchImpl: fakeFetch
    };

    assert.deepEqual(await verifyFinalizedDeposit(options), {
        state: "finalized",
        amountRaw: "10000",
        sourceWalletAddress: sourceWallet,
        finalizedSlot: 500,
        finalizedAt: 1700000000
    });
    const finalizedTransaction = structuredClone(transaction);
    const directTreasuryTransaction = structuredClone(transaction);
    directTreasuryTransaction.meta.preTokenBalances = [{
        accountIndex: 1,
        mint: officialMint,
        owner: sourceWallet,
        uiTokenAmount: { amount: "20000" }
    }];
    directTreasuryTransaction.meta.postTokenBalances = [
        {
            accountIndex: 2,
            mint: officialMint,
            owner: depositAddress,
            uiTokenAmount: { amount: "10000" }
        },
        {
            accountIndex: 1,
            mint: officialMint,
            owner: sourceWallet,
            uiTokenAmount: { amount: "10000" }
        }
    ];
    transaction = directTreasuryTransaction;
    assert.deepEqual(await verifyFinalizedDeposit({
        ...options,
        requirePaymentIntentMemo: true
    }), { state: "payment_intent_mismatch" });
    assert.deepEqual(await verifyFinalizedDeposit({ ...options, expectedSourceWallet: sourceWallet }), {
        state: "finalized",
        amountRaw: "10000",
        sourceWalletAddress: sourceWallet,
        finalizedSlot: 500,
        finalizedAt: 1700000000
    });
    const intentId = "8f9ef883-520e-45ef-96ae-62e621d3b31c";
    const memoProgramId = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
    directTreasuryTransaction.transaction.message.instructions.push({
        programId: memoProgramId,
        data: encodeBase58(Buffer.from(`RelicGrid payment intent: ${intentId}`))
    });
    const intentOptions = {
        ...options,
        expectedSourceWallet: sourceWallet,
        expectedAmountRaw: "10000",
        requiredMemo: `RelicGrid payment intent: ${intentId}`
    };
    assert.deepEqual(await verifyFinalizedDeposit(intentOptions), {
        state: "finalized",
        amountRaw: "10000",
        sourceWalletAddress: sourceWallet,
        finalizedSlot: 500,
        finalizedAt: 1700000000
    });
    assert.deepEqual(await verifyFinalizedDeposit({
        ...options,
        requirePaymentIntentMemo: true
    }), {
        state: "finalized",
        amountRaw: "10000",
        sourceWalletAddress: sourceWallet,
        finalizedSlot: 500,
        finalizedAt: 1700000000,
        paymentIntentId: intentId
    });
    assert.deepEqual(await verifyFinalizedDeposit({ ...intentOptions, expectedAmountRaw: "10001" }), {
        state: "wrong_amount"
    });
    assert.deepEqual(await verifyFinalizedDeposit({
        ...options,
        minimumAmountRaw: "100000000"
    }), { state: "wrong_amount" });
    assert.deepEqual(await verifyFinalizedDeposit({
        ...options,
        minimumAmountRaw: "10000"
    }), {
        state: "finalized",
        amountRaw: "10000",
        sourceWalletAddress: sourceWallet,
        finalizedSlot: 500,
        finalizedAt: 1700000000
    });
    assert.deepEqual(await verifyFinalizedDeposit({
        ...intentOptions,
        requiredMemo: "RelicGrid payment intent: 00000000-0000-4000-8000-000000000000"
    }), { state: "payment_intent_mismatch" });

    directTreasuryTransaction.transaction.message.instructions[0].parsed.info.authority = tokenAccount;
    directTreasuryTransaction.transaction.message.accountKeys[0] =
        { pubkey: sourceWallet, signer: false };
    assert.deepEqual(await verifyFinalizedDeposit({ ...options, expectedSourceWallet: sourceWallet }), {
        state: "wrong_destination_or_token"
    });
    transaction = structuredClone(finalizedTransaction);
    status = { err: null, confirmationStatus: "confirmed" };
    assert.deepEqual(await verifyFinalizedDeposit(options), { state: "pending" });
    status = { err: null, confirmationStatus: "finalized" };
    transaction = structuredClone(finalizedTransaction);
    transaction.meta.postTokenBalances[0].mint = "11111111111111111111111111111111";
    assert.deepEqual(await verifyFinalizedDeposit(options), { state: "wrong_destination_or_token" });
    transaction = structuredClone(finalizedTransaction);
    transaction.meta.postTokenBalances[0].owner = tokenAccount;
    assert.deepEqual(await verifyFinalizedDeposit(options), { state: "wrong_destination_or_token" });
    transaction = finalizedTransaction;
    await assert.rejects(
        verifyFinalizedDeposit({ ...options, network: "mainnet-beta" }),
        /different network/
    );
    status = { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" };
    assert.deepEqual(await verifyFinalizedDeposit(options), { state: "failed" });
});

test("deposit API rejects a failed on-chain transaction before requesting ledger credit", async () => {
    const environment = {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "public-test-key",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-test-key",
        SOLANA_RPC_URL: "https://mainnet.example/rpc",
        SOLANA_NETWORK: "mainnet-beta",
        SOLANA_TREASURY_ADDRESS: "BQa1gxbBP2jNJEzyHHtMAUfJepXjTnqQEhBuojL9E3ts",
        WALLET_DIRECT_TREASURY_READY: "true",
        WALLET_DEPOSITS_ENABLED: "true",
        WALLET_MAINNET_DEPOSITS_ENABLED: "true"
    };
    const previousEnvironment = Object.fromEntries(
        Object.keys(environment).map((name) => [name, process.env[name]])
    );
    Object.assign(process.env, environment);
    const originalFetch = globalThis.fetch;
    const rpcMethods = [];
    const mintAddress = "9F4hLLngEAhepsH2HLTH6kBYmmq6dzm4GXRrcpME3uam";
    const paymentIntentId = "8f9ef883-520e-45ef-96ae-62e621d3b31c";
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
        }
        if (target.includes("/wallet_system_config?")) {
            return new Response(JSON.stringify([{
                deposits_enabled: true,
                network: "mainnet-beta",
                official_mint_address: mintAddress,
                token_program_id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                token_decimals: 8,
                credits_per_token: "10000",
                rounding_policy: "floor",
                treasury_address: environment.SOLANA_TREASURY_ADDRESS
            }]), { status: 200 });
        }
        if (target.includes("/wallet_payment_intents?")) {
            return new Response(JSON.stringify([{
                id: paymentIntentId,
                player_id: "test-player",
                network: "mainnet-beta",
                mint_address: mintAddress,
                token_program_id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                treasury_address: environment.SOLANA_TREASURY_ADDRESS,
                amount_raw: "100000000",
                token_decimals: 8,
                created_at: new Date(Date.now() - 1000).toISOString(),
                expires_at: new Date(Date.now() + 60000).toISOString(),
                status: "pending",
                transaction_signature: null
            }]), { status: 200 });
        }
        if (target === environment.SOLANA_RPC_URL) {
            const call = JSON.parse(options.body);
            rpcMethods.push(call.method);
            const result = call.method === "getGenesisHash"
                ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
                : { value: [{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" }] };
            return new Response(JSON.stringify({ result }), { status: 200 });
        }
        throw new Error(`Unexpected failed-deposit API request: ${target}`);
    };

    try {
        const endpoint = require("../api/deposits.js");
        const response = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "POST",
            headers: { authorization: "Bearer test-token" },
            body: { signature: "1".repeat(64) }
        }, response);

        assert.equal(response.statusCode, 422);
        assert.equal(response.payload.error, "transaction_failed");
        assert.deepEqual(rpcMethods, ["getGenesisHash", "getSignatureStatuses"]);
    } finally {
        globalThis.fetch = originalFetch;
        for (const [name, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test("deposit API credits a finalized transfer only with its authenticated player payment intent", async () => {
    const environment = {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "public-test-key",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-test-key",
        SOLANA_RPC_URL: "https://mainnet.example/rpc",
        SOLANA_NETWORK: "mainnet-beta",
        SOLANA_TREASURY_ADDRESS: "BQa1gxbBP2jNJEzyHHtMAUfJepXjTnqQEhBuojL9E3ts",
        WALLET_DIRECT_TREASURY_READY: "true",
        WALLET_DEPOSITS_ENABLED: "true",
        WALLET_MAINNET_DEPOSITS_ENABLED: "true"
    };
    const previousEnvironment = Object.fromEntries(
        Object.keys(environment).map((name) => [name, process.env[name]])
    );
    Object.assign(process.env, environment);
    const originalFetch = globalThis.fetch;
    const signature = "1".repeat(64);
    const paymentIntentId = "8f9ef883-520e-45ef-96ae-62e621d3b31c";
    const sourceWallet = "11111111111111111111111111111111";
    let rpcSourceWallet = null;
    let creditedIntentId = null;
    let authenticatedPlayer = "test-player";
    let intentStatus = "pending";
    let intentSignature = null;
    let ledgerCallCount = 0;
    const authorization = "Bearer deposit-test-token";
    const sourceTokenAccount = "So11111111111111111111111111111111111111112";
    const mintAddress = "9F4hLLngEAhepsH2HLTH6kBYmmq6dzm4GXRrcpME3uam";
    const tokenProgramId = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const treasuryTokenAccount = deriveAssociatedTokenAccount(
        environment.SOLANA_TREASURY_ADDRESS,
        mintAddress,
        tokenProgramId
    );
    const transaction = {
        slot: 500,
        blockTime: Math.floor(Date.now() / 1000),
        transaction: {
            signatures: [signature],
            message: {
                accountKeys: [
                    { pubkey: sourceWallet, signer: true },
                    sourceTokenAccount,
                    treasuryTokenAccount
                ],
                instructions: [
                    {
                        programId: tokenProgramId,
                        parsed: {
                            type: "transferChecked",
                            info: {
                                mint: mintAddress,
                                source: sourceTokenAccount,
                                destination: treasuryTokenAccount,
                                authority: sourceWallet,
                                tokenAmount: { amount: "100000000" }
                            }
                        }
                    },
                    {
                        programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
                        parsed: { type: "memo", info: `RelicGrid payment intent: ${paymentIntentId}` }
                    }
                ]
            }
        },
        meta: {
            err: null,
            preTokenBalances: [
                {
                    accountIndex: 1,
                    mint: mintAddress,
                    owner: sourceWallet,
                    uiTokenAmount: { amount: "1000000000" }
                },
                {
                    accountIndex: 2,
                    mint: mintAddress,
                    owner: environment.SOLANA_TREASURY_ADDRESS,
                    uiTokenAmount: { amount: "0" }
                }
            ],
            postTokenBalances: [
                {
                    accountIndex: 1,
                    mint: mintAddress,
                    owner: sourceWallet,
                    uiTokenAmount: { amount: "750000000" }
                },
                {
                    accountIndex: 2,
                    mint: mintAddress,
                    owner: environment.SOLANA_TREASURY_ADDRESS,
                    uiTokenAmount: { amount: "100000000" }
                }
            ]
        }
    };
    let rpcPayload;
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: authenticatedPlayer }), { status: 200 });
        }
        if (target.includes("/wallet_system_config?")) {
            return new Response(JSON.stringify([{
                deposits_enabled: true,
                network: "mainnet-beta",
                official_mint_address: mintAddress,
                token_program_id: tokenProgramId,
                token_decimals: 8,
                credits_per_token: "10000",
                rounding_policy: "floor",
                treasury_address: environment.SOLANA_TREASURY_ADDRESS
            }]), { status: 200 });
        }
        if (target.includes("/wallet_payment_intents?")) {
            const intent = {
                id: paymentIntentId,
                player_id: "test-player",
                network: "mainnet-beta",
                mint_address: mintAddress,
                token_program_id: tokenProgramId,
                treasury_address: environment.SOLANA_TREASURY_ADDRESS,
                amount_raw: "100000000",
                token_decimals: 8,
                created_at: new Date(Date.now() - 60000).toISOString(),
                expires_at: new Date(Date.now() + 60000).toISOString(),
                status: intentStatus,
                transaction_signature: intentSignature
            };
            const ownsIntent = target.includes("&player_id=eq.test-player");
            return new Response(JSON.stringify(ownsIntent ? [intent] : []), { status: 200 });
        }
        if (target === environment.SOLANA_RPC_URL) {
            const call = JSON.parse(options.body);
            const result = call.method === "getGenesisHash"
                ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
                : call.method === "getSignatureStatuses"
                    ? { value: [{ err: null, confirmationStatus: "finalized" }] }
                    : call.method === "getTransaction"
                        ? transaction
                        : call.params[0] === environment.SOLANA_TREASURY_ADDRESS
                            ? { value: { owner: "11111111111111111111111111111111", data: ["", "base64"] } }
                            : call.params[0] === treasuryTokenAccount
                                ? { value: { owner: tokenProgramId, data: { parsed: { type: "account", info: { mint: mintAddress, owner: environment.SOLANA_TREASURY_ADDRESS } } } } }
                                : { value: { owner: tokenProgramId, data: { parsed: { type: "mint", info: {
                                    decimals: 8,
                                    mintAuthority: null,
                                    freezeAuthority: null
                                } } } } };
            return new Response(JSON.stringify({ result }), { status: 200 });
        }
        if (target.includes("/rpc/process_verified_payment_intent")) {
            const alreadyApplied = ledgerCallCount > 0;
            ledgerCallCount += 1;
            rpcPayload = JSON.parse(options.body);
            rpcSourceWallet = rpcPayload.p_source_wallet_address;
            creditedIntentId = rpcPayload.p_payment_intent_id;
            intentStatus = "confirmed";
            intentSignature = signature;
            return new Response(JSON.stringify([{
                balance_credits: "250000",
                already_applied: alreadyApplied
            }]), { status: 200 });
        }
        throw new Error(`Unexpected wallet-less deposit request: ${target}`);
    };

    try {
        const endpoint = require("../api/deposits.js");
        const otherPlayerResponse = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        authenticatedPlayer = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        await endpoint({
            method: "POST",
            headers: { authorization },
            body: { signature: `https://solscan.io/tx/${signature}` }
        }, otherPlayerResponse);
        assert.equal(otherPlayerResponse.statusCode, 409);
        assert.equal(otherPlayerResponse.payload.error, "payment_intent_invalid_or_claimed");
        assert.equal(ledgerCallCount, 0);

        authenticatedPlayer = "test-player";
        const response = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "POST",
            headers: { authorization: "Bearer walletless-deposit-test-token" },
            body: { signature }
        }, response);

        assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
        assert.equal(response.payload.status, "confirmed");
        assert.equal(response.payload.credited, true);
        assert.equal(response.payload.creditAmountCredits, "10000");
        assert.equal(rpcSourceWallet, sourceWallet);
        assert.equal(creditedIntentId, paymentIntentId);
        assert.equal(rpcPayload.p_deposit_address, environment.SOLANA_TREASURY_ADDRESS);
        assert.equal(rpcPayload.p_amount_raw, "100000000");

        const duplicateResponse = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "POST",
            headers: { authorization },
            body: { signature }
        }, duplicateResponse);
        assert.equal(duplicateResponse.statusCode, 200);
        assert.equal(duplicateResponse.payload.alreadyProcessed, true);
        assert.equal(duplicateResponse.payload.credited, false);
        assert.equal(ledgerCallCount, 2);
    } finally {
        globalThis.fetch = originalFetch;
        for (const [name, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test("deposit amount parsing uses exact token base units and rejects malformed precision", () => {
    assert.equal(parseTokenAmount("1", 8), "100000000");
    assert.equal(parseTokenAmount("0.0001", 8), "10000");
    assert.equal(parseTokenAmount("1.23000000", 8), "123000000");
    assert.throws(() => parseTokenAmount("0", 8), /greater than zero/);
    assert.throws(() => parseTokenAmount("1.000000001", 8), /supported token decimals/);
    assert.throws(() => parseTokenAmount("1e3", 8), /supported token decimals/);
});

test("payment-intent API creates an authenticated intent without a linked wallet", async () => {
    const environment = {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "public-test-key",
        SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
        SOLANA_RPC_URL: "https://mainnet.example/rpc",
        SOLANA_NETWORK: "mainnet-beta",
        WALLET_DIRECT_TREASURY_READY: "true",
        WALLET_DEPOSITS_ENABLED: "true",
        WALLET_MAINNET_DEPOSITS_ENABLED: "true"
    };
    const previousEnvironment = Object.fromEntries(
        Object.keys(environment).map((name) => [name, process.env[name]])
    );
    const previousTreasuryEnvironment = process.env.SOLANA_TREASURY_ADDRESS;
    delete process.env.SOLANA_TREASURY_ADDRESS;
    for (const [name, value] of Object.entries(environment)) process.env[name] = value;
    const originalFetch = globalThis.fetch;
    const requests = [];
    let persistedIntent = null;
    const mintAddress = "9F4hLLngEAhepsH2HLTH6kBYmmq6dzm4GXRrcpME3uam";
    let configuredMintAddress = mintAddress;
    const tokenProgramId = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const treasuryTokenAccount = deriveAssociatedTokenAccount(
        RELICGRID_TREASURY_ADDRESS,
        mintAddress,
        tokenProgramId
    );
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        requests.push({ target, options });
        if (target.endsWith("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
        }
        if (target.includes("/wallet_system_config?")) {
            return new Response(JSON.stringify([{
                deposits_enabled: true,
                network: "mainnet-beta",
                official_mint_address: configuredMintAddress,
                token_program_id: tokenProgramId,
                token_decimals: 8,
                credits_per_token: "10000",
                rounding_policy: "floor",
                treasury_address: RELICGRID_TREASURY_ADDRESS
            }]), { status: 200 });
        }
        if (target === environment.SOLANA_RPC_URL) {
            const call = JSON.parse(options.body);
            const result = call.method === "getGenesisHash"
                ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
                : call.params[0] === RELICGRID_TREASURY_ADDRESS
                    ? { value: { owner: "11111111111111111111111111111111" } }
                    : call.params[0] === mintAddress
                        ? { value: { owner: tokenProgramId, data: { parsed: { type: "mint", info: {
                            decimals: 8,
                            mintAuthority: null,
                            freezeAuthority: null
                        } } } } }
                        : { value: { owner: tokenProgramId, data: { parsed: { type: "account", info: { mint: mintAddress, owner: RELICGRID_TREASURY_ADDRESS } } } } };
            return new Response(JSON.stringify({ result }), { status: 200 });
        }
        if (target.includes("/wallet_payment_intents?") && options.method === "DELETE") {
            return new Response(null, { status: 204 });
        }
        if (target.includes("/wallet_payment_intents?") && options.method === "POST") {
            const intent = JSON.parse(options.body);
            persistedIntent = intent;
            return new Response(JSON.stringify([{
                id: intent.id,
                expires_at: intent.expires_at
            }]), { status: 201 });
        }
        if (target.includes("/wallet_payment_intents?")) {
            return new Response(JSON.stringify(persistedIntent ? [persistedIntent] : []), { status: 200 });
        }
        throw new Error(`Unexpected payment-intent API request: ${target}`);
    };

    try {
        const endpoint = require("../api/payment-intent.js");
        configuredMintAddress = "So11111111111111111111111111111111111111112";
        const wrongMintResponse = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "POST",
            headers: { authorization: "Bearer test-session" },
            body: {}
        }, wrongMintResponse);
        assert.equal(wrongMintResponse.statusCode, 503);
        assert.equal(wrongMintResponse.payload.error, "wallet_configuration_incomplete");
        assert.equal(persistedIntent, null);
        configuredMintAddress = mintAddress;

        const response = {
            statusCode: 200,
            headers: {},
            status(code) { this.statusCode = code; return this; },
            setHeader(name, value) { this.headers[name] = value; },
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "POST",
            headers: { authorization: "Bearer test-token" },
            body: {}
        }, response);

        assert.equal(response.statusCode, 201);
        assert.equal(response.payload.amountRaw, "100000000");
        assert.equal(Object.hasOwn(response.payload, "sourceWalletAddress"), false);
        assert.equal(response.payload.treasuryAddress, RELICGRID_TREASURY_ADDRESS);
        assert.equal(response.payload.treasuryTokenAccount, deriveAssociatedTokenAccount(
            RELICGRID_TREASURY_ADDRESS,
            mintAddress,
            tokenProgramId
        ));
        assert.equal(response.payload.memo, `RelicGrid payment intent: ${response.payload.intentId}`);
        assert.equal(requests.some(({ options }) => options.method === "DELETE"), true);
        const createdIntent = JSON.parse(
            requests.find(({ target, options }) =>
                target.includes("/wallet_payment_intents?") && options.method === "POST"
            ).options.body
        );
        assert.equal(createdIntent.player_id, "test-player");
        assert.equal(createdIntent.source_wallet_address, null);
        assert.equal(createdIntent.amount_raw, "100000000");
        assert.equal(requests.some(({ options }) =>
            options.body && JSON.parse(options.body).amount !== undefined
        ), false);
        assert.equal(createdIntent.status, "pending");
        assert.equal(
            Date.parse(createdIntent.expires_at) - Date.parse(createdIntent.created_at),
            15 * 60 * 1000
        );

        const validateIntent = async () => {
            const validationResponse = {
                statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                setHeader() {},
                json(payload) { this.payload = payload; }
            };
            await endpoint({
                method: "POST",
                headers: { authorization: "Bearer test-token" },
                body: { action: "validate", paymentIntentId: response.payload.intentId }
            }, validationResponse);
            return validationResponse;
        };
        const validIntent = await validateIntent();
        assert.equal(validIntent.statusCode, 200);
        assert.equal(validIntent.payload.intentId, response.payload.intentId);
        assert.equal(Object.hasOwn(validIntent.payload, "sourceWalletAddress"), false);
        assert.equal(validIntent.payload.amountRaw, "100000000");
        assert.equal(validIntent.payload.memo, response.payload.memo);
        persistedIntent.expires_at = new Date(Date.now() - 1000).toISOString();
        const expiredIntent = await validateIntent();
        assert.equal(expiredIntent.statusCode, 409);
        assert.equal(expiredIntent.payload.error, "payment_intent_invalid_or_expired");
    } finally {
        globalThis.fetch = originalFetch;
        for (const [name, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        if (previousTreasuryEnvironment === undefined) delete process.env.SOLANA_TREASURY_ADDRESS;
        else process.env.SOLANA_TREASURY_ADDRESS = previousTreasuryEnvironment;
    }
});

test("level entry API rejects insufficient balances and never enables paid gameplay", async () => {
    const previousUrl = process.env.SUPABASE_URL;
    const previousKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "public-test-key";
    const originalFetch = globalThis.fetch;
    const endpoint = require("../api/level-entry.js");

    async function requestEntry(balance) {
        globalThis.fetch = async (url) => {
            const target = String(url);
            if (target.includes("/auth/v1/user")) {
                return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
            }
            if (target.includes("/level_completions?")) {
                return new Response(JSON.stringify([{ level_number: 1 }, { level_number: 3 }]), { status: 200 });
            }
            if (target.includes("/wallet_credit_accounts?")) {
                return new Response(JSON.stringify([{ balance_credits: balance }]), { status: 200 });
            }
            throw new Error(`Unexpected wallet API request: ${target}`);
        };
        const response = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "POST",
            headers: { authorization: "Bearer test-access-token" },
            body: { levelNumber: 1 }
        }, response);
        return response;
    }

    try {
        const insufficient = await requestEntry("99");
        assert.equal(insufficient.statusCode, 402);
        assert.equal(insufficient.payload.error, "insufficient_balance");
        assert.equal(insufficient.payload.entryCostCredits, 100);
        assert.equal(insufficient.payload.balanceVerified, true);

        const sufficientButDisabled = await requestEntry("100");
        assert.equal(sufficientButDisabled.statusCode, 503);
        assert.equal(sufficientButDisabled.payload.error, "paid_gameplay_disabled");
        assert.equal(sufficientButDisabled.payload.paidGameplayEnabled, false);
        assert.equal(sufficientButDisabled.payload.balanceVerified, true);
    } finally {
        globalThis.fetch = originalFetch;
        if (previousUrl === undefined) delete process.env.SUPABASE_URL;
        else process.env.SUPABASE_URL = previousUrl;
        if (previousKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
        else process.env.SUPABASE_PUBLISHABLE_KEY = previousKey;
    }
});

test("level entry API validates campaign unlocks before checking wallet funds", async () => {
    const previousUrl = process.env.SUPABASE_URL;
    const previousKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "public-test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const target = String(url);
        if (target.includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
        }
        if (target.includes("/level_completions?")) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Locked-level check should not read wallet funds: ${target}`);
    };

    try {
        const endpoint = require("../api/level-entry.js");
        const response = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "POST",
            headers: { authorization: "Bearer test-access-token" },
            body: { levelNumber: 4 }
        }, response);
        assert.equal(response.statusCode, 403);
        assert.equal(response.payload.error, "level_locked");
        assert.equal(response.payload.unlockedLevel, 1);
    } finally {
        globalThis.fetch = originalFetch;
        if (previousUrl === undefined) delete process.env.SUPABASE_URL;
        else process.env.SUPABASE_URL = previousUrl;
        if (previousKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
        else process.env.SUPABASE_PUBLISHABLE_KEY = previousKey;
    }
});

test("enabled level entry sends a stable request ID to the atomic charge operation", async () => {
    const names = [
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "WALLET_PAID_GAMEPLAY_ENABLED"
    ];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "public-test-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "server-only-test-key";
    process.env.WALLET_PAID_GAMEPLAY_ENABLED = "true";
    const originalFetch = globalThis.fetch;
    let rpcPayload;
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
        }
        if (target.includes("/level_completions?")) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        if (target.includes("/wallet_credit_accounts?")) {
            return new Response(JSON.stringify([{ balance_credits: "100" }]), { status: 200 });
        }
        if (target.includes("/wallet_system_config?")) {
            return new Response(JSON.stringify([{ paid_gameplay_enabled: true }]), { status: 200 });
        }
        if (target.includes("/rpc/start_wallet_level")) {
            rpcPayload = JSON.parse(options.body);
            return new Response(JSON.stringify([{
                session_id: "123e4567-e89b-42d3-a456-426614174000",
                balance_credits: "0",
                entry_cost_credits: 100
            }]), { status: 200 });
        }
        throw new Error(`Unexpected level-entry request: ${target}`);
    };

    try {
        const endpoint = require("../api/level-entry.js");
        const response = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "POST",
            headers: { authorization: "Bearer test-access-token" },
            body: {
                levelNumber: 1,
                requestId: "123e4567-e89b-42d3-a456-426614174001"
            }
        }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.allowed, true);
        assert.equal(response.payload.balanceCredits, "0");
        assert.equal(rpcPayload.p_player_id, "test-player");
        assert.equal(rpcPayload.p_level_number, 1);
        assert.equal(rpcPayload.p_request_id, "123e4567-e89b-42d3-a456-426614174001");
    } finally {
        globalThis.fetch = originalFetch;
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    }
});

test("deposit API refuses to process deposits until trusted server configuration exists", async () => {
    const envNames = [
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SOLANA_RPC_URL",
        "SOLANA_NETWORK",
        "SOLANA_TREASURY_ADDRESS",
        "WALLET_DIRECT_TREASURY_READY",
        "WALLET_DEPOSITS_ENABLED",
        "WALLET_MAINNET_DEPOSITS_ENABLED"
    ];
    const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "public-test-key";
    for (const name of envNames.slice(2)) delete process.env[name];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ id: "test-player" }), { status: 200 });

    try {
        const depositsEndpoint = require("../api/deposits.js");
        const response = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await depositsEndpoint({
            method: "POST",
            headers: { authorization: "Bearer test-access-token" }
        }, response);
        assert.equal(response.statusCode, 503);
        assert.equal(response.payload.error, "wallet_verifier_not_configured");
        assert.equal(response.payload.fundingStatus, "disabled");
        assert.match(response.payload.message, /SUPABASE_SERVICE_ROLE_KEY/);
        assert.match(response.payload.message, /Do not send CYFUR/);
    } finally {
        globalThis.fetch = originalFetch;
        for (const name of envNames) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    }
});

test("deposit API requires explicit direct-treasury readiness", async () => {
    const names = [
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SOLANA_RPC_URL",
        "SOLANA_NETWORK",
        "SOLANA_TREASURY_ADDRESS",
        "WALLET_DIRECT_TREASURY_READY",
        "WALLET_DEPOSITS_ENABLED",
        "WALLET_MAINNET_DEPOSITS_ENABLED"
    ];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "public-test-key",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-test-key",
        SOLANA_RPC_URL: "https://solana.example/rpc",
        SOLANA_NETWORK: "devnet",
        SOLANA_TREASURY_ADDRESS: "11111111111111111111111111111111",
        WALLET_DEPOSITS_ENABLED: "true"
    });
    delete process.env.WALLET_DIRECT_TREASURY_READY;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url).includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
        }
        throw new Error(`Deposit must remain gated before trusted lookups: ${url}`);
    };

    try {
        const endpoint = require("../api/deposits.js");
        const response = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "POST",
            headers: { authorization: "Bearer test-access-token" },
            body: { signature: "1".repeat(64) }
        }, response);
        assert.equal(response.statusCode, 503);
        assert.equal(response.payload.error, "direct_treasury_not_ready");
        assert.equal(response.payload.fundingStatus, "disabled");
    } finally {
        globalThis.fetch = originalFetch;
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    }
});

test("deposit API remains disabled unless the explicit server flag is enabled", async () => {
    const envNames = [
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SOLANA_RPC_URL",
        "SOLANA_NETWORK",
        "SOLANA_TREASURY_ADDRESS",
        "WALLET_DIRECT_TREASURY_READY",
        "WALLET_DEPOSITS_ENABLED",
        "WALLET_MAINNET_DEPOSITS_ENABLED"
    ];
    const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "public-test-key",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-test-key",
        SOLANA_RPC_URL: "https://solana.example/rpc",
        SOLANA_NETWORK: "devnet",
        SOLANA_TREASURY_ADDRESS: "11111111111111111111111111111111",
        WALLET_DIRECT_TREASURY_READY: "true"
    })) process.env[name] = value;
    delete process.env.WALLET_DEPOSITS_ENABLED;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url).includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
        }
        throw new Error(`Disabled deposit endpoint must not call trusted services: ${url}`);
    };
    try {
        const endpoint = require("../api/deposits.js");
        const response = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "POST",
            headers: { authorization: "Bearer test-session" },
            body: { signature: "1".repeat(64) }
        }, response);
        assert.equal(response.statusCode, 503);
        assert.equal(response.payload.error, "deposits_disabled");
        assert.equal(response.payload.fundingStatus, "disabled");
    } finally {
        globalThis.fetch = originalFetch;
        for (const name of envNames) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    }
});

test("deposit transaction API prepares and broadcasts through the authenticated server RPC", async () => {
    const envNames = [
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SOLANA_RPC_URL",
        "SOLANA_NETWORK",
        "SOLANA_TREASURY_ADDRESS",
        "WALLET_DIRECT_TREASURY_READY",
        "WALLET_DEPOSITS_ENABLED"
    ];
    const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "public-test-key",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-test-key",
        SOLANA_RPC_URL: "https://mainnet.example/rpc",
        SOLANA_NETWORK: "mainnet-beta",
        SOLANA_TREASURY_ADDRESS: "BQa1gxbBP2jNJEzyHHtMAUfJepXjTnqQEhBuojL9E3ts",
        WALLET_DIRECT_TREASURY_READY: "true",
        WALLET_DEPOSITS_ENABLED: "true",
        WALLET_MAINNET_DEPOSITS_ENABLED: "true"
    });

    const linkedWallet = "11111111111111111111111111111111";
    const senderTokenAccount = "11111111111111111111111111111113";
    const treasuryTokenAccount = "11111111111111111111111111111114";
    const signature = "1".repeat(64);
    const paymentIntentId = "8f9ef883-520e-45ef-96ae-62e621d3b31c";
    let intentExpiresAt = new Date(Date.now() + 60_000).toISOString();
    let intentStatus = "pending";
    const rpcCalls = [];
    let denyRpc = false;
    let rpcError = null;
    let rpcErrorOnce = null;
    let missingDiagnosticSource = false;
    let paymentIntentReadCount = 0;
    let diagnosticSimulation = { err: null, logs: [], unitsConsumed: 15000 };
    const mintAddress = "9F4hLLngEAhepsH2HLTH6kBYmmq6dzm4GXRrcpME3uam";
    const tokenProgramId = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const associatedTokenProgramId = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    const memoProgramId = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
    const sourceAccountKey = Buffer.alloc(32, 6);
    const treasuryAccountKey = Buffer.alloc(32, 8);
    const sourceAccountAddress = encodeBase58(sourceAccountKey);
    const treasuryAccountAddress = encodeBase58(treasuryAccountKey);
    const shortVec = (value) => Buffer.from([value]);
    const compiledInstruction = (programIndex, accountIndexes, data) => Buffer.concat([
        Buffer.from([programIndex]),
        shortVec(accountIndexes.length),
        Buffer.from(accountIndexes),
        shortVec(data.length),
        Buffer.from(data)
    ]);
    const transferCheckedData = Buffer.alloc(10);
    transferCheckedData[0] = 12;
    transferCheckedData[9] = 8;
    for (let index = 0; index < 8; index += 1) {
        transferCheckedData[index + 1] = Number((100000000n >> BigInt(index * 8)) & 0xffn);
    }
    const transactionMessage = Buffer.concat([
        Buffer.from([1, 0, 6]),
        shortVec(10),
        Buffer.from(decodeWalletBytes(linkedWallet)),
        Buffer.alloc(32, 4),
        Buffer.from(decodeWalletBytes(linkedWallet)),
        Buffer.from(decodeWalletBytes("11111111111111111111111111111111")),
        Buffer.from(decodeWalletBytes(tokenProgramId)),
        Buffer.from(decodeWalletBytes(associatedTokenProgramId)),
        sourceAccountKey,
        Buffer.from(decodeWalletBytes(mintAddress)),
        treasuryAccountKey,
        Buffer.from(decodeWalletBytes(memoProgramId)),
        Buffer.alloc(32, 10),
        shortVec(3),
        compiledInstruction(5, [0, 1, 2, 7, 3, 4], [1]),
        compiledInstruction(4, [6, 7, 8, 0], transferCheckedData),
        compiledInstruction(9, [0], Buffer.from("RelicGrid test memo"))
    ]);
    const signedTransactionBase64 = Buffer.concat([
        shortVec(1),
        Buffer.alloc(64),
        transactionMessage
    ]).toString("base64");
    const diagnosticMessage = Buffer.concat([
        Buffer.from([1, 0, 6]),
        shortVec(10),
        Buffer.from(decodeWalletBytes(linkedWallet)),
        Buffer.alloc(32, 4),
        Buffer.from(decodeWalletBytes(linkedWallet)),
        Buffer.from(decodeWalletBytes("11111111111111111111111111111111")),
        Buffer.from(decodeWalletBytes(tokenProgramId)),
        Buffer.from(decodeWalletBytes(associatedTokenProgramId)),
        sourceAccountKey,
        Buffer.from(decodeWalletBytes(mintAddress)),
        treasuryAccountKey,
        Buffer.from(decodeWalletBytes(memoProgramId)),
        Buffer.alloc(32, 10),
        shortVec(3),
        compiledInstruction(5, [0, 6, 2, 7, 3, 4], [1]),
        compiledInstruction(4, [6, 7, 8, 0], transferCheckedData),
        compiledInstruction(9, [0], Buffer.from("RelicGrid read-only preflight"))
    ]);
    const unsignedDiagnosticTransaction = Buffer.concat([
        shortVec(1),
        Buffer.alloc(64),
        diagnosticMessage
    ]).toString("base64");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
        }
        if (target.includes("/rest/v1/wallet_system_config")) {
            return new Response(JSON.stringify([{
                deposits_enabled: true,
                network: "mainnet-beta",
                official_mint_address: "9F4hLLngEAhepsH2HLTH6kBYmmq6dzm4GXRrcpME3uam",
                token_program_id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                token_decimals: 8,
                credits_per_token: 10000,
                rounding_policy: "floor",
                treasury_address: process.env.SOLANA_TREASURY_ADDRESS
            }]), { status: 200 });
        }
        if (target.includes("/rest/v1/player_solana_wallets")) {
            return new Response(JSON.stringify([{ wallet_address: linkedWallet }]), { status: 200 });
        }
        if (target.includes("/rest/v1/wallet_payment_intents")) {
            paymentIntentReadCount += 1;
            return new Response(JSON.stringify([{
                id: paymentIntentId,
                player_id: "test-player",
                source_wallet_address: linkedWallet,
                network: "mainnet-beta",
                mint_address: "9F4hLLngEAhepsH2HLTH6kBYmmq6dzm4GXRrcpME3uam",
                token_program_id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                treasury_address: process.env.SOLANA_TREASURY_ADDRESS,
                amount_raw: "100000000",
                token_decimals: 8,
                expires_at: intentExpiresAt,
                status: intentStatus
            }]), { status: 200 });
        }
        if (target === process.env.SOLANA_RPC_URL) {
            if (denyRpc) return new Response("", { status: 403 });
            const call = JSON.parse(options.body);
            rpcCalls.push(call);
            if (call.method === "sendTransaction" && rpcErrorOnce) {
                const error = rpcErrorOnce;
                rpcErrorOnce = null;
                return new Response(JSON.stringify({ error }), { status: 200 });
            }
            if (call.method === "sendTransaction" && rpcError) {
                return new Response(JSON.stringify({ error: rpcError }), { status: 200 });
            }
            const results = {
                getGenesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
                getTokenAccountsByOwner: {
                    value: [{ pubkey: call.params[0] === linkedWallet
                        ? senderTokenAccount
                        : treasuryTokenAccount }]
                },
                getLatestBlockhash: {
                    value: {
                        blockhash: "11111111111111111111111111111116",
                        lastValidBlockHeight: 123
                    }
                },
                getBalance: { context: { slot: 456 }, value: 920000 },
                getMinimumBalanceForRentExemption: 2039280,
                getFeeForMessage: { context: { slot: 456 }, value: 80000 },
                getAccountInfo: call.params[0] === linkedWallet
                    ? {
                        value: {
                            owner: "11111111111111111111111111111111",
                            lamports: 920000,
                            executable: false,
                            data: ["", "base64"]
                        }
                    }
                    : call.params[0] === sourceAccountAddress && missingDiagnosticSource
                    ? { value: null }
                    : {
                    value: {
                        owner: tokenProgramId,
                        data: {
                            parsed: {
                                type: "account",
                                info: {
                                    owner: call.params[0] === sourceAccountAddress
                                        ? linkedWallet
                                        : process.env.SOLANA_TREASURY_ADDRESS,
                                    mint: mintAddress,
                                    tokenAmount: { amount: "100000000" }
                                }
                            }
                        }
                    }
                },
                simulateTransaction: { value: diagnosticSimulation },
                getSlot: 456,
                sendTransaction: signature
            };
            return new Response(JSON.stringify({ result: results[call.method] }), { status: 200 });
        }
        throw new Error(`Unexpected test request: ${target}`);
    };

    const endpoint = require("../api/deposit-transaction.js");
    const invoke = async (body) => {
        const response = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(payload) { this.payload = payload; }
        };
        await endpoint({
            method: "POST",
            headers: { authorization: "Bearer test-access-token" },
            body
        }, response);
        return response;
    };

    try {
        const prepared = await invoke({ action: "prepare" });
        assert.equal(prepared.statusCode, 200);
        assert.deepEqual(getDepositPreparationFieldErrors(prepared.payload), []);
        assert.equal(prepared.payload.blockhash, "11111111111111111111111111111116");
        assert.deepEqual(prepared.payload.senderTokenAccounts, [senderTokenAccount]);
        assert.deepEqual(prepared.payload.treasuryTokenAccounts, [treasuryTokenAccount]);
        assert.deepEqual(rpcCalls.map((call) => call.method), [
            "getGenesisHash",
            "getTokenAccountsByOwner",
            "getTokenAccountsByOwner",
            "getLatestBlockhash"
        ]);
        assert.equal(rpcCalls.at(-1).params[0].commitment, "confirmed");
        assert.equal("contextSlot" in prepared.payload, false);

        const previousDirectTreasuryReady = process.env.WALLET_DIRECT_TREASURY_READY;
        const previousDepositsEnabled = process.env.WALLET_DEPOSITS_ENABLED;
        const previousMainnetEnabled = process.env.WALLET_MAINNET_DEPOSITS_ENABLED;
        process.env.WALLET_DIRECT_TREASURY_READY = "false";
        process.env.WALLET_DEPOSITS_ENABLED = "false";
        process.env.WALLET_MAINNET_DEPOSITS_ENABLED = "false";
        const intentReadsBeforeDiagnostic = paymentIntentReadCount;
        const rpcCallsBeforeDiagnostic = rpcCalls.length;
        missingDiagnosticSource = true;
        const diagnosticPreparation = await invoke({ action: "prepare-diagnostic" });
        assert.equal(diagnosticPreparation.statusCode, 200);
        const readOnlyDiagnostic = await invoke({
            action: "diagnose",
            amountRaw: "100000000",
            transaction: unsignedDiagnosticTransaction,
            connectedWalletPublicKey: linkedWallet
        });
        assert.equal(readOnlyDiagnostic.statusCode, 200);
        assert.equal(readOnlyDiagnostic.payload.feePayerAccountExists, true);
        assert.equal(readOnlyDiagnostic.payload.feePayerOwnerProgram, "11111111111111111111111111111111");
        assert.equal(readOnlyDiagnostic.payload.feePayerSystemProgramOwned, true);
        assert.equal(readOnlyDiagnostic.payload.feePayerKeyMatchesConnectedPhantom, true);
        assert.equal(readOnlyDiagnostic.payload.feePayerKeyMatchesLinkedWallet, true);
        assert.equal(readOnlyDiagnostic.payload.payerBalanceQueryMatchesFeePayer, true);
        assert.equal(readOnlyDiagnostic.payload.payerLamports, 920000);
        assert.equal(readOnlyDiagnostic.payload.transactionFeeLamports, 80000);
        assert.equal(readOnlyDiagnostic.payload.requiredRentLamports, 2039280);
        assert.equal(readOnlyDiagnostic.payload.requiredTotalLamports, 2119280);
        assert.equal(readOnlyDiagnostic.payload.payerBalanceCoversFeeAndRent, false);
        assert.equal(readOnlyDiagnostic.payload.sourceTokenAccountExists, false);
        assert.equal(readOnlyDiagnostic.payload.treasuryTokenAccountExists, true);
        assert.equal(readOnlyDiagnostic.payload.simulationPassed, true);
        const diagnosticRpcCalls = rpcCalls.slice(rpcCallsBeforeDiagnostic);
        assert.equal(diagnosticRpcCalls.some((call) => call.method === "sendTransaction"), false);
        assert.deepEqual(diagnosticRpcCalls.at(-1).params[1], {
            encoding: "base64",
            commitment: "confirmed",
            sigVerify: false,
            replaceRecentBlockhash: true
        });
        assert.equal(paymentIntentReadCount, intentReadsBeforeDiagnostic);

        diagnosticSimulation = {
            err: { InstructionError: [0, { Custom: 1 }] },
            logs: [
                "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr failed: custom program error: 0x1",
                "Program log: account 11111111111111111111111111111113 failed"
            ],
            unitsConsumed: 1234
        };
        const simulatedFailure = await invoke({
            action: "diagnose",
            amountRaw: "100000000",
            transaction: unsignedDiagnosticTransaction,
            connectedWalletPublicKey: linkedWallet
        });
        assert.equal(simulatedFailure.statusCode, 200);
        assert.equal(simulatedFailure.payload.simulationPassed, false);
        assert.equal(simulatedFailure.payload.failedInstructionIndex, 0);
        assert.equal(simulatedFailure.payload.failedInstructionRole, "associated_token_account_create");
        assert.match(simulatedFailure.payload.simulationError, /InstructionError/);
        assert.match(simulatedFailure.payload.simulationLogs[0], /\[memo-program\]/);
        assert.match(simulatedFailure.payload.simulationLogs[1], /\[redacted-address\]/);

        const rpcCallsBeforeWalletMismatch = rpcCalls.length;
        const walletMismatch = await invoke({
            action: "diagnose",
            amountRaw: "100000000",
            transaction: unsignedDiagnosticTransaction,
            connectedWalletPublicKey: "11111111111111111111111111111115"
        });
        assert.equal(walletMismatch.statusCode, 400);
        assert.match(walletMismatch.payload.message, /public key.*must match/i);
        assert.equal(rpcCalls.length, rpcCallsBeforeWalletMismatch);
        process.env.WALLET_DIRECT_TREASURY_READY = previousDirectTreasuryReady;
        process.env.WALLET_DEPOSITS_ENABLED = previousDepositsEnabled;
        process.env.WALLET_MAINNET_DEPOSITS_ENABLED = previousMainnetEnabled;
        missingDiagnosticSource = false;

        const broadcast = await invoke({
            action: "broadcast",
            paymentIntentId,
            transaction: signedTransactionBase64
        });
        assert.equal(broadcast.statusCode, 200);
        assert.equal(broadcast.payload.signature, signature);
        assert.equal(rpcCalls.at(-1).method, "sendTransaction");
        assert.equal(rpcCalls.at(-1).params[1].encoding, "base64");
        assert.equal(rpcCalls.at(-1).params[0], signedTransactionBase64);
        assert.equal(rpcCalls.at(-1).params[1].minContextSlot, 456);
        assert.deepEqual(rpcCalls.slice(-3).map((call) => call.method), [
            "getGenesisHash",
            "getSlot",
            "sendTransaction"
        ]);

        const broadcastCallsBeforeContextRetry = rpcCalls.length;
        rpcErrorOnce = {
            code: -32016,
            message: "Minimum context slot has not been reached"
        };
        const contextRetry = await invoke({
            action: "broadcast",
            paymentIntentId,
            transaction: signedTransactionBase64
        });
        assert.equal(contextRetry.statusCode, 200);
        assert.equal(contextRetry.payload.signature, signature);
        const contextRetryCalls = rpcCalls.slice(broadcastCallsBeforeContextRetry);
        assert.deepEqual(contextRetryCalls.map((call) => call.method), [
            "getGenesisHash",
            "getSlot",
            "sendTransaction",
            "sendTransaction"
        ]);
        assert.equal(contextRetryCalls[2].params[0], signedTransactionBase64);
        assert.equal(contextRetryCalls[3].params[0], signedTransactionBase64);
        assert.equal(contextRetryCalls[2].params[1].minContextSlot, 456);
        assert.equal("minContextSlot" in contextRetryCalls[3].params[1], false);
        assert.equal(contextRetryCalls[3].params[1].preflightCommitment, "confirmed");
        assert.equal(contextRetryCalls[3].params[1].skipPreflight, undefined);

        const invalid = await invoke({ action: "broadcast", transaction: "not base64!" });
        assert.equal(invalid.statusCode, 400);
        assert.equal(invalid.payload.error, "payment_intent_required");
        const invalidTransaction = await invoke({
            action: "broadcast",
            paymentIntentId,
            transaction: "not base64!"
        });
        assert.equal(invalidTransaction.statusCode, 400);
        assert.equal(invalidTransaction.payload.error, "invalid_signed_transaction");
        const missingContext = await invoke({
            action: "broadcast",
            paymentIntentId,
            transaction: signedTransactionBase64
        });
        assert.equal(missingContext.statusCode, 200);
        assert.equal(missingContext.payload.signature, signature);
        assert.equal(rpcCalls.at(-2).method, "getSlot");
        assert.equal(rpcCalls.at(-1).params[1].minContextSlot, 456);

        rpcError = {
            code: -32002,
            message: "Transaction simulation failed: Blockhash not found at https://rpc.example/?api-key=dummy and address 11111111111111111111111111111111",
            data: {
                err: { InstructionError: [2, { Custom: 1 }] },
                logs: [
                    "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr invoke [1]",
                    "Program log: account 11111111111111111111111111111113 failed",
                    "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr failed: custom program error: 0x1"
                ],
                unitsConsumed: 12000,
                accounts: [{ lamports: 123, data: "private-account-data" }]
            }
        };
        const originalConsoleError = console.error;
        const originalConsoleInfo = console.info;
        const diagnosticLogs = [];
        console.error = (...args) => diagnosticLogs.push(args);
        console.info = (...args) => diagnosticLogs.push(args);
        let staleBlockhash;
        try {
            staleBlockhash = await invoke({
                action: "broadcast",
                paymentIntentId,
                transaction: signedTransactionBase64
            });
        } finally {
            console.error = originalConsoleError;
            console.info = originalConsoleInfo;
        }
        assert.equal(staleBlockhash.statusCode, 409);
        assert.equal(staleBlockhash.payload.error, "blockhash_expired");
        const diagnostic = diagnosticLogs.find(([message]) =>
            message === "Deposit transaction request failed."
        )?.[1];
        assert.equal(diagnostic.stage, "broadcast_rpc_send");
        assert.equal(diagnostic.rpcCode, -32002);
        assert.match(diagnostic.rpcMessage, /Blockhash not found/);
        assert.deepEqual(JSON.parse(diagnostic.rpcData.err), {
            InstructionError: [2, { Custom: 1 }]
        });
        assert.equal(diagnostic.rpcData.logs[0], "Program [memo-program] invoke [1]");
        assert.match(diagnostic.rpcData.logs[1], /\[redacted-address\]/);
        assert.equal(diagnostic.rpcData.unitsConsumed, 12000);
        assert.equal(diagnostic.rpcData.accountCount, 1);
        assert.equal("accounts" in diagnostic.rpcData, false);
        assert.doesNotMatch(JSON.stringify(diagnostic), /rpc\.example|api-key|11111111111111111111111111111113|private-account-data/);
        const fundingDiagnostic = diagnosticLogs.find(([message]) =>
            message === "Deposit transaction simulation funding diagnostics."
        )?.[1];
        assert.deepEqual(fundingDiagnostic.instructionRoles, [
            "associated_token_account_create",
            "spl_token_transfer_checked",
            "memo"
        ]);
        assert.equal(fundingDiagnostic.associatedTokenAccountCreateCount, 1);
        assert.equal(fundingDiagnostic.payerLamports, 920000);
        assert.equal(fundingDiagnostic.transactionFeeLamports, 80000);
        assert.equal(fundingDiagnostic.tokenAccountRentLamports, 2039280);
        assert.equal(fundingDiagnostic.requiredTotalLamports, 2119280);
        assert.equal(fundingDiagnostic.payerBalanceCoversFeeAndRent, false);
        assert.equal(fundingDiagnostic.sourceTokenAccountExists, true);
        assert.equal(fundingDiagnostic.sourceTokenAccountOwnerMatchesPayer, true);
        assert.equal(fundingDiagnostic.sourceTokenAccountMintMatchesIntent, true);
        assert.equal(fundingDiagnostic.sourceTokenAmountCoversIntent, true);
        assert.equal(fundingDiagnostic.treasuryTokenAccountExists, true);
        assert.equal(fundingDiagnostic.treasuryTokenAccountOwnerMatchesTreasury, true);
        assert.doesNotMatch(
            JSON.stringify(fundingDiagnostic),
            new RegExp(`${linkedWallet}|${sourceAccountAddress}|${treasuryAccountAddress}|${signedTransactionBase64}`)
        );
        rpcError = {
            code: -32002,
            message: "Transaction simulation failed: custom program error"
        };
        const failedSimulation = await invoke({
            action: "broadcast",
            paymentIntentId,
            transaction: signedTransactionBase64
        });
        assert.equal(failedSimulation.statusCode, 502);
        assert.equal(failedSimulation.payload.error, "solana_rpc_unavailable");

        const rpcCallCountBeforeExpiredIntent = rpcCalls.length;
        intentExpiresAt = new Date(Date.now() - 1000).toISOString();
        const expiredIntent = await invoke({
            action: "broadcast",
            paymentIntentId,
            transaction: signedTransactionBase64
        });
        assert.equal(expiredIntent.statusCode, 409);
        assert.equal(expiredIntent.payload.error, "payment_intent_invalid_or_expired");
        assert.equal(rpcCalls.length, rpcCallCountBeforeExpiredIntent);

        denyRpc = true;
        const forbidden = await invoke({ action: "prepare" });
        assert.equal(forbidden.statusCode, 502);
        assert.equal(forbidden.payload.error, "solana_rpc_forbidden");
        assert.match(forbidden.payload.message, /HTTP 403/);
    } finally {
        globalThis.fetch = originalFetch;
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test("each connected star outcome uses its configured time threshold and payout", () => {
    for (const level of levels) {
        const { threeSeconds, twoSeconds } = level.starTimeTargets;
        assert.deepEqual(evaluateLevelStars(level, threeSeconds * 1000), {
            stars: 3,
            rewardCredits: level.economy.threeStarPayoutCredits,
            status: "completed"
        });
        assert.deepEqual(evaluateLevelStars(level, threeSeconds * 1000 + 1), {
            stars: 2,
            rewardCredits: level.economy.twoStarRefundCredits,
            status: "completed"
        });
        assert.deepEqual(evaluateLevelStars(level, twoSeconds * 1000 + 1), {
            stars: 1,
            rewardCredits: 0,
            status: "completed"
        });
    }
});

test("no battery connection is a fail with no stars and no payout", () => {
    assert.deepEqual(evaluateLevelStars(levels[0], levels[0].starTimeTargets.threeSeconds * 1000, false), {
        stars: 0,
        rewardCredits: 0,
        status: "fail"
    });
});

test("time thresholds are ordered and scale with each level's puzzle complexity", () => {
    assert.deepEqual(levels[0].starTimeTargets, { threeSeconds: 35, twoSeconds: 80 });
    for (const level of levels) {
        const targets = getLevelStarTimeTargets(level);
        assert.equal(level.starTimeTargets.threeSeconds, targets.threeSeconds);
        assert.equal(level.starTimeTargets.twoSeconds, targets.twoSeconds);
        assert.ok(targets.threeSeconds < targets.twoSeconds);
        assert.equal(evaluateLevelStars(level, targets.threeSeconds * 1000 - 1).stars, 3);
        assert.equal(evaluateLevelStars(level, targets.twoSeconds * 1000).stars, 2);
        assert.equal(evaluateLevelStars(level, targets.twoSeconds * 1000 + 1).stars, 1);
    }
});

test("invalid elapsed times and incomplete solves never receive a reward", () => {
    for (const elapsed of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(evaluateLevelStars(levels[0], elapsed).stars, 0);
        assert.equal(evaluateLevelStars(levels[0], elapsed).rewardCredits, 0);
    }
    assert.equal(evaluateLevelStars(levels[0], 0, false).status, "fail");
});

test("solve timer measures only elapsed time until a real battery connection", () => {
    assert.equal(calculateSolveTimeMilliseconds(1000, 4500, true), 3500);
    assert.equal(calculateSolveTimeMilliseconds(1000, 4500, false), null);
    assert.equal(calculateSolveTimeMilliseconds(4500, 1000, true), null);
    assert.equal(calculateSolveTimeMilliseconds(Number.NaN, 4500, true), null);
});

test("invalid per-level timing configuration is rejected", () => {
    assert.throws(() => evaluateLevelStars({
        number: 1,
        par: 1,
        starTimeTargets: { threeSeconds: 90, twoSeconds: 60 }
    }, 1000), /Invalid star-time thresholds/);
});

test("entry costs, payouts, and refunds follow floor rounding for all 99 levels", () => {
    for (let level = 1; level <= 99; level++) {
        const cost = Math.floor(100 * Math.pow(1.08, level - 1));
        assert.deepEqual(getLevelEconomy(level), {
            entryCostCredits: cost,
            threeStarPayoutCredits: Math.floor(cost * 1.6),
            twoStarRefundCredits: Math.floor(cost * 0.4),
            oneStarPayoutCredits: 0
        });
    }
});

test("a level completion event can only be claimed once per level", () => {
    const seen = new Set();
    assert.equal(claimLevelCompletion(1, seen), true);
    assert.equal(claimLevelCompletion(1, seen), false);
    assert.equal(claimLevelCompletion(100, seen), false);
    assert.equal(claimLevelCompletion(2, null), false);
});

test("all 99 generated layouts are unique, valid, and solvable through every ordered crystal", () => {
    const signatures = new Set();
    const deltas = [
        { row: -1, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 0 },
        { row: 0, col: -1 }
    ];
    const slashReflection = [1, 0, 3, 2];
    const backslashReflection = [3, 2, 1, 0];
    const scene = readFileSync(new URL("../script.js", import.meta.url), "utf8");

    assert.equal(levels.length, 99);
    assert.match(scene, /const coreScale = 0\.36/);
    assert.match(scene, /decorativeTerminalGroup\.visible = false/);
    assert.match(scene, /function createFacetedCrystalGeometry\(radius, height, segments = 6\)/);
    assert.match(scene, /createFacetedCrystalGeometry\(shard\.radius, shard\.height, 5\)/);
    assert.match(scene, /createFacetedCrystalGeometry\(0\.28 \* scale, shaftHeight, 6\)/);
    assert.match(scene, /vertexColors: true/);
    assert.doesNotMatch(scene, /new THREE\.BoxGeometry\(0\.25 \* scale, shaftHeight, 0\.25 \* scale\)/);
    assert.match(scene, /const shards = \[/);
    assert.doesNotMatch(scene, /addCylinder\(crystalGroup, 0\.3, 0\.38/);
    assert.match(scene, /new THREE\.TubeGeometry\(curve, 1, 0\.14, 8, false\)/);
    assert.match(scene, /color: 0xe5fbff/);
    for (const [index, level] of levels.entries()) {
        assert.equal(level.number, index + 1);
        assert.ok(level.start.row >= 0 && level.start.row < 6);
        assert.ok(level.start.col >= 0 && level.start.col < 8);
        assert.ok(level.target.row >= 0 && level.target.row < 6);
        assert.ok(level.target.col >= 0 && level.target.col < 8);
        assert.ok(level.target.row >= 2 && level.target.row <= 4, `Level ${level.number} target is too close to the back or front scenery.`);
        assert.ok(level.target.col >= 2 && level.target.col <= 5, `Level ${level.number} target is too close to side scenery.`);
        assert.ok(level.par > 0);
        assert.equal(level.solutionMirrors.length, level.par);

        const signature = JSON.stringify({
            start: level.start,
            target: level.target,
            solutionMirrors: level.solutionMirrors,
            crystals: level.crystals,
            obstacles: level.obstacles
        });
        assert.equal(signatures.has(signature), false, `Level ${level.number} duplicates a generated layout.`);
        signatures.add(signature);

        const obstacles = new Set(level.obstacles.map(({ row, col }) => `${row},${col}`));
        const mirrorCells = new Set(level.solutionMirrors.map(({ row, col }) => `${row},${col}`));
        const crystals = new Map(level.crystals.map((crystal) => [
            `${crystal.row},${crystal.col}`,
            crystal
        ]));
        const mirrors = new Map(level.solutionMirrors.map((mirror) => [`${mirror.row},${mirror.col}`, mirror.orientation]));
        const crystalCells = [...crystals.keys()];
        assert.equal(level.crystals.length, 1 + Math.floor((level.band - 1) / 2));
        assert.equal(crystalCells.length, level.crystals.length);
        for (const crystal of level.crystals) {
            const key = `${crystal.row},${crystal.col}`;
            assert.equal(obstacles.has(key), false);
            assert.equal(mirrorCells.has(key), false);
            assert.notEqual(key, `${level.start.row},${level.start.col}`);
            assert.notEqual(key, `${level.target.row},${level.target.col}`);
            assert.ok(crystal.inputColor >= 0 && crystal.inputColor < 3);
            assert.ok(crystal.outputColor >= 0 && crystal.outputColor < 3);
            const targetDistance = Math.hypot(crystal.row - level.target.row, crystal.col - level.target.col);
            const sourceDistance = Math.hypot(crystal.row - level.start.row, crystal.col - level.start.col);
            assert.ok(targetDistance >= 1, `Level ${level.number} crystal overlaps the battery cell.`);
            assert.ok(sourceDistance >= 1, `Level ${level.number} crystal overlaps the source cell.`);
        }
        assert.equal(obstacles.has(`${level.start.row},${level.start.col}`), false);
        assert.equal(obstacles.has(`${level.target.row},${level.target.col}`), false);
        const targetGridX = -5.6 + level.target.col * 1.4;
        const targetGridZ = -3.8 + level.target.row * 1.4;
        assert.ok(Math.hypot(targetGridX + 2.55, targetGridZ + 3.55) > 1.8,
            `Level ${level.number} target overlaps the source pylon clearance.`);
        const coreScale = 0.36;
        const corePositionX = targetGridX - 1.35 * coreScale;
        const corePositionZ = targetGridZ - 0.1 * coreScale;
        assert.ok(Math.abs(corePositionX + 1.35 * coreScale - targetGridX) < 1e-12);
        assert.ok(Math.abs(corePositionZ + 0.1 * coreScale - targetGridZ) < 1e-12);
        assert.ok(2 * 1.82 * coreScale < 1.4, `Level ${level.number} core spills into adjacent cells.`);

        let row = level.start.row;
        let col = level.start.col;
        let direction = level.start.direction;
        let colorIndex = 0;
        let nextCrystal = 0;
        const visited = new Set();
        let connected = false;
        for (let step = 0; step < 6 * 8 * 2; step++) {
            const state = `${row},${col},${direction}`;
            assert.equal(visited.has(state), false, `Level ${level.number} solution loops.`);
            visited.add(state);
            row += deltas[direction].row;
            col += deltas[direction].col;
            assert.ok(row >= 0 && row < 6 && col >= 0 && col < 8, `Level ${level.number} solution exits the board.`);
            if (obstacles.has(`${row},${col}`)) {
                assert.fail(`Level ${level.number} solution intersects an obstacle.`);
            }
            if (row === level.target.row && col === level.target.col) {
                connected = true;
                break;
            }
            const orientation = mirrors.get(`${row},${col}`);
            if (orientation === "/") direction = slashReflection[direction];
            else if (orientation === "\\") direction = backslashReflection[direction];
            if (orientation) colorIndex++;
            const crystal = crystals.get(`${row},${col}`);
            if (crystal) {
                assert.equal(crystal.inputColor, colorIndex % 3, `Level ${level.number} crystal has the wrong input color.`);
                assert.equal(crystal.outputColor, (crystal.inputColor + 1) % 3);
                colorIndex = crystal.outputColor;
                nextCrystal++;
            }
        }
        assert.equal(connected, true, `Level ${level.number} solution does not connect to its battery.`);
        assert.equal(nextCrystal, level.crystals.length, `Level ${level.number} solution must activate every crystal.`);
    }
    assert.equal(signatures.size, 99);
});
