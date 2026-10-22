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
    getPhantomProvider,
    isMobileBrowser,
    readPhantomMobileCallback,
    savePhantomMobileSession,
    startPhantomMobileConnect,
    waitForPhantomProvider
} from "../wallet-provider.mjs";
import { calculateSolveTimeMilliseconds, claimLevelCompletion, CYFUR_CREDITS_PER_TOKEN, evaluateLevelStars, getLevelEconomy, getLevelStarTimeTargets, levels } from "../levels.js";

const require = createRequire(import.meta.url);
const nacl = require("tweetnacl");
const {
    CYFUR_CREDITS_PER_TOKEN: apiCreditsPerToken,
    getDepositCreditAmount,
    getLevelEntryCostCredits
} = require("../api/_lib/wallet.js");
const { verifyFinalizedDeposit } = require("../api/_lib/solana-deposit.js");
const { getLevelEconomyAndStars, verifyLevelProof } = require("../api/_lib/level-completion.js");
const { verifyWalletSignature } = require("../api/_lib/solana-wallet-link.js");

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
        "SOLANA_TREASURY_ADDRESS",
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
    globalThis.fetch = async (url) => {
        const target = String(url);
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
        assert.ok(response.payload.readinessChecks.includes("Connect and verify your Solana wallet."));
        assert.ok(response.payload.readinessChecks.includes("Set SUPABASE_SERVICE_ROLE_KEY in Vercel."));
        assert.ok(response.payload.readinessChecks.includes("Set WALLET_DEPOSITS_ENABLED=true in Vercel after approval."));
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
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    assert.match(app, /next-level[\s\S]*?startLevel\(number, true\)/);
    assert.doesNotMatch(app, /playLevelTransition|transitionFor/);
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
    assert.match(app, /game-guide-close/);
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

test("direct treasury migration binds deposits to linked wallets and leaves payments disabled", () => {
    const migration = readFileSync(new URL("../supabase-direct-treasury-deposits.sql", import.meta.url), "utf8");
    assert.match(migration, /deposits_enabled = false/);
    assert.match(migration, /paid_gameplay_enabled = false/);
    assert.match(migration, /create table if not exists public\.player_solana_wallets/);
    assert.match(migration, /create table if not exists public\.wallet_link_challenges/);
    assert.match(migration, /create or replace function public\.link_player_solana_wallet/);
    assert.match(migration, /expires_at > now\(\)/);
    assert.match(migration, /create or replace function public\.process_verified_treasury_deposit/);
    assert.match(migration, /v_config\.treasury_address is distinct from p_deposit_address/);
    assert.match(migration, /from public\.player_solana_wallets/);
    assert.match(migration, /on conflict \(network, transaction_signature\) do nothing/i);
    assert.match(migration, /public\.apply_wallet_ledger_entry/);
    assert.match(migration, /to service_role/i);
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

test("wallet-link API issues a challenge and links only after a valid player signature", async () => {
    const envNames = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
    const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "public-test-key",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-test-key"
    });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const walletAddress = encodeBase58(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const originalFetch = globalThis.fetch;
    let storedChallenge;
    let linkedWallet;
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
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
        assert.equal(linkedWallet.p_player_id, "test-player");
        assert.equal(linkedWallet.p_wallet_address, walletAddress);
        assert.equal(linkedWallet.p_challenge, challengeResponse.payload.challenge);
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
    let transaction = {
        slot: 500,
        transaction: {
            signatures: [signature],
            message: {
                accountKeys: [tokenAccount],
                instructions: [{
                    programId: tokenProgramId,
                    parsed: {
                        type: "transferChecked",
                        info: {
                            mint: officialMint,
                            destination: tokenAccount,
                            tokenAmount: { amount: "10000" }
                        }
                    }
                }]
            }
        },
        meta: {
            err: null,
            preTokenBalances: [],
            postTokenBalances: [{
                accountIndex: 0,
                mint: officialMint,
                owner: depositAddress,
                uiTokenAmount: { amount: "10000" }
            }]
        }
    };
    let status = { err: null, confirmationStatus: "finalized" };
    const fakeFetch = async (_url, options) => {
        const { method } = JSON.parse(options.body);
        const result = method === "getGenesisHash"
            ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
            : method === "getSignatureStatuses"
                ? { value: [status] }
                : method === "getTransaction"
                    ? transaction
                    : { value: { owner: tokenProgramId, data: { parsed: { type: "mint", info: { decimals: 8 } } } } };
        return new Response(JSON.stringify({ result }), { status: 200 });
    };
    const options = {
        signature,
        depositAddress,
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
        finalizedSlot: 500
    });
    const finalizedTransaction = structuredClone(transaction);
    const sourceWallet = "11111111111111111111111111111111";
    const sourceTokenAccount = "Stake11111111111111111111111111111111111111";
    const directTreasuryTransaction = structuredClone(transaction);
    directTreasuryTransaction.transaction.message.accountKeys = [tokenAccount, sourceTokenAccount];
    directTreasuryTransaction.transaction.message.instructions[0].parsed.info.source = sourceTokenAccount;
    directTreasuryTransaction.transaction.message.instructions[0].parsed.info.authority = sourceWallet;
    directTreasuryTransaction.meta.preTokenBalances = [{
        accountIndex: 1,
        mint: officialMint,
        owner: sourceWallet,
        uiTokenAmount: { amount: "20000" }
    }];
    directTreasuryTransaction.meta.postTokenBalances = [
        {
            accountIndex: 0,
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
    assert.deepEqual(await verifyFinalizedDeposit({ ...options, expectedSourceWallet: sourceWallet }), {
        state: "finalized",
        amountRaw: "10000",
        finalizedSlot: 500
    });
    directTreasuryTransaction.transaction.message.instructions[0].parsed.info.authority = tokenAccount;
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
        "WALLET_DEPOSITS_ENABLED"
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
        "WALLET_DEPOSITS_ENABLED"
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
        SOLANA_RPC_URL: "https://solana.example/rpc",
        SOLANA_NETWORK: "devnet",
        SOLANA_TREASURY_ADDRESS: "11111111111111111111111111111112",
        WALLET_DIRECT_TREASURY_READY: "true",
        WALLET_DEPOSITS_ENABLED: "true"
    });
    delete process.env.WALLET_MAINNET_DEPOSITS_ENABLED;

    const linkedWallet = "11111111111111111111111111111111";
    const senderTokenAccount = "11111111111111111111111111111113";
    const treasuryTokenAccount = "11111111111111111111111111111114";
    const signature = "1".repeat(64);
    const rpcCalls = [];
    let denyRpc = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "test-player" }), { status: 200 });
        }
        if (target.includes("/rest/v1/wallet_system_config")) {
            return new Response(JSON.stringify([{
                deposits_enabled: true,
                network: "devnet",
                official_mint_address: "11111111111111111111111111111115",
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
        if (target === process.env.SOLANA_RPC_URL) {
            if (denyRpc) return new Response("", { status: 403 });
            const call = JSON.parse(options.body);
            rpcCalls.push(call);
            const results = {
                getGenesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
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
        assert.equal(prepared.payload.blockhash, "11111111111111111111111111111116");
        assert.deepEqual(prepared.payload.senderTokenAccounts, [senderTokenAccount]);
        assert.deepEqual(prepared.payload.treasuryTokenAccounts, [treasuryTokenAccount]);
        assert.deepEqual(rpcCalls.map((call) => call.method), [
            "getGenesisHash",
            "getTokenAccountsByOwner",
            "getTokenAccountsByOwner",
            "getLatestBlockhash"
        ]);

        const broadcast = await invoke({
            action: "broadcast",
            transaction: Buffer.from([1, 2, 3]).toString("base64")
        });
        assert.equal(broadcast.statusCode, 200);
        assert.equal(broadcast.payload.signature, signature);
        assert.equal(rpcCalls.at(-1).method, "sendTransaction");
        assert.equal(rpcCalls.at(-1).params[1].encoding, "base64");

        const invalid = await invoke({ action: "broadcast", transaction: "not base64!" });
        assert.equal(invalid.statusCode, 400);
        assert.equal(invalid.payload.error, "invalid_signed_transaction");

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

    assert.equal(levels.length, 99);
    for (const [index, level] of levels.entries()) {
        assert.equal(level.number, index + 1);
        assert.ok(level.start.row >= 0 && level.start.row < 6);
        assert.ok(level.start.col >= 0 && level.start.col < 8);
        assert.ok(level.target.row >= 0 && level.target.row < 6);
        assert.ok(level.target.col >= 0 && level.target.col < 8);
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
        assert.equal(level.crystals.length, 1 + Math.floor((level.band - 1) / 2));
        for (const crystal of level.crystals) {
            const key = `${crystal.row},${crystal.col}`;
            assert.equal(obstacles.has(key), false);
            assert.equal(mirrorCells.has(key), false);
            assert.ok(crystal.inputColor >= 0 && crystal.inputColor < 3);
            assert.ok(crystal.outputColor >= 0 && crystal.outputColor < 3);
        }
        assert.equal(obstacles.has(`${level.start.row},${level.start.col}`), false);
        assert.equal(obstacles.has(`${level.target.row},${level.target.col}`), false);

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
