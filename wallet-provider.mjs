const walletStandardRegistries = new WeakMap();
const walletStandardAccounts = new WeakMap();
const walletStandardAdapters = new WeakMap();
const walletConnections = new WeakMap();
const connectionListeners = new WeakSet();
const mobileProviders = new WeakMap();
const mobileStateKey = "fluxgrid.phantom.deeplink.v1";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function getDepositPreparationFieldErrors(preparation) {
    const errors = [];
    const value = preparation && typeof preparation === "object" ? preparation : {};
    if (typeof value.blockhash !== "string" ||
        value.blockhash.length < 32 || value.blockhash.length > 44 ||
        [...value.blockhash].some((character) => !BASE58_ALPHABET.includes(character))) {
        errors.push({
            field: "blockhash",
            actualType: typeof value.blockhash,
            actualLength: typeof value.blockhash === "string" ? value.blockhash.length : null
        });
    }
    if (!Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight <= 0) {
        errors.push({
            field: "lastValidBlockHeight",
            actualType: typeof value.lastValidBlockHeight,
            isSafeInteger: Number.isSafeInteger(value.lastValidBlockHeight),
            isPositive: typeof value.lastValidBlockHeight === "number" && value.lastValidBlockHeight > 0
        });
    }
    for (const field of ["senderTokenAccounts", "treasuryTokenAccounts"]) {
        const accounts = value[field];
        if (!Array.isArray(accounts)) {
            errors.push({ field, actualType: typeof accounts });
            continue;
        }
        const invalidAccountCount = accounts.filter((account) =>
            typeof account !== "string" ||
            account.length < 32 ||
            account.length > 44 ||
            [...account].some((character) => !BASE58_ALPHABET.includes(character))
        ).length;
        if (invalidAccountCount > 0) {
            errors.push({
                field,
                actualType: "array",
                arrayLength: accounts.length,
                invalidAccountCount
            });
        }
    }
    return errors;
}

function getNacl(walletWindow) {
    const nacl = walletWindow.nacl;
    if (!nacl?.box?.keyPair || !nacl.box.open?.after) {
        throw new Error("Secure Phantom mobile signing is unavailable. Reload the page and try again.");
    }
    return nacl;
}

function encodeBase58(bytes) {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let value = 0n;
    for (const byte of bytes) value = value * 256n + BigInt(byte);
    let encoded = "";
    while (value > 0n) {
        encoded = alphabet[Number(value % 58n)] + encoded;
        value /= 58n;
    }
    for (const byte of bytes) {
        if (byte !== 0) break;
        encoded = `1${encoded}`;
    }
    return encoded || "1";
}

function decodeBase58(value) {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let number = 0n;
    for (const character of value) {
        const digit = alphabet.indexOf(character);
        if (digit < 0) throw new Error("Phantom returned invalid encoded response data.");
        number = number * 58n + BigInt(digit);
    }
    const bytes = [];
    while (number > 0n) {
        bytes.unshift(Number(number & 0xffn));
        number >>= 8n;
    }
    for (const character of value) {
        if (character !== "1") break;
        bytes.unshift(0);
    }
    return Uint8Array.from(bytes);
}

function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64ToBytes(value) {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function readMobileState(walletWindow) {
    const storage = walletWindow.localStorage;
    if (!storage || typeof storage.getItem !== "function") return null;
    const serialized = storage.getItem(mobileStateKey);
    if (!serialized) return null;
    try {
        return JSON.parse(serialized);
    } catch (error) {
        storage.removeItem(mobileStateKey);
        console.error("Stored Phantom deeplink state could not be read.", error);
        return null;
    }
}

function writeMobileState(walletWindow, state) {
    walletWindow.localStorage.setItem(mobileStateKey, JSON.stringify(state));
}

function buildCallbackUrl(walletWindow, state) {
    const callback = new URL(walletWindow.location.href);
    callback.searchParams.set("phantom_callback", "1");
    callback.searchParams.set("phantom_state", state);
    return callback.toString();
}

function startPhantomMessageSign(walletWindow, { challenge, session, phantomPublicKey, sharedSecret, walletAddress }) {
    const nacl = getNacl(walletWindow);
    const stored = readMobileState(walletWindow);
    if (!stored?.state || !sharedSecret) throw new Error("Reconnect Phantom before signing.");
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const payload = nacl.box.after(
        new TextEncoder().encode(JSON.stringify({
            message: encodeBase58(new TextEncoder().encode(challenge)),
            session,
            display: "utf8"
        })),
        nonce,
        base64ToBytes(sharedSecret)
    );
    const callbackUrl = buildCallbackUrl(walletWindow, stored.state);
    writeMobileState(walletWindow, {
        ...stored,
        action: "wallet-link-sign",
        challenge,
        walletAddress
    });
    const url = new URL("https://phantom.com/ul/v1/signMessage");
    url.searchParams.set("dapp_encryption_public_key", encodeBase58(base64ToBytes(stored.publicKey)));
    url.searchParams.set("nonce", encodeBase58(nonce));
    url.searchParams.set("redirect_link", callbackUrl);
    url.searchParams.set("payload", encodeBase58(payload));
    walletWindow.location.assign(url.toString());
}

function startPhantomTransactionSign(walletWindow, transaction, options = {}) {
    const nacl = getNacl(walletWindow);
    const stored = readMobileState(walletWindow);
    if (!stored?.session || !stored?.sharedSecret) throw new Error("Connect Phantom before approving a deposit.");
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const serialized = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false
    });
    const payload = nacl.box.after(
        new TextEncoder().encode(JSON.stringify({
            transaction: encodeBase58(serialized),
            session: stored.session
        })),
        nonce,
        base64ToBytes(stored.sharedSecret)
    );
    const callbackUrl = buildCallbackUrl(walletWindow, stored.state);
    writeMobileState(walletWindow, {
        ...stored,
        action: "deposit-sign",
        network: options.chain ?? "mainnet-beta",
        paymentIntentId: options.paymentIntentId,
        paymentIntentAmountRaw: options.paymentIntentAmountRaw,
        paymentIntentExpiresAt: options.paymentIntentExpiresAt,
        blockhashRetryCount: options.blockhashRetryCount ?? 0
    });
    const url = new URL("https://phantom.com/ul/v1/signTransaction");
    url.searchParams.set("dapp_encryption_public_key", encodeBase58(base64ToBytes(stored.publicKey)));
    url.searchParams.set("nonce", encodeBase58(nonce));
    url.searchParams.set("redirect_link", callbackUrl);
    url.searchParams.set("payload", encodeBase58(payload));
    walletWindow.location.assign(url.toString());
}

function createMobileProvider(walletWindow, stored) {
    const existing = mobileProviders.get(walletWindow);
    if (existing) return existing;
    const provider = {
        isPhantom: true,
        isMobileDeepLink: true,
        isConnected: true,
        connect() {
            return Promise.resolve({ publicKey: { toString: () => stored.walletAddress } });
        },
        signMessage(message) {
            const challenge = new TextDecoder().decode(message);
            startPhantomMessageSign(walletWindow, {
                challenge,
                session: stored.session,
                phantomPublicKey: stored.phantomPublicKey,
                sharedSecret: stored.sharedSecret,
                walletAddress: stored.walletAddress
            });
            return new Promise(() => {});
        },
        sendTransaction(transaction, _connection, options) {
            startPhantomTransactionSign(walletWindow, transaction, options);
            return new Promise(() => {});
        }
    };
    mobileProviders.set(walletWindow, provider);
    return provider;
}

function getWalletConnection(walletWindow) {
    let connection = walletConnections.get(walletWindow);
    if (!connection) {
        connection = { provider: null, publicKey: null };
        walletConnections.set(walletWindow, connection);
    }
    return connection;
}

function getWalletStandardWallets(walletWindow) {
    const existing = walletStandardRegistries.get(walletWindow);
    if (existing) return existing;
    const wallets = [];
    walletStandardRegistries.set(walletWindow, wallets);
    if (typeof walletWindow.addEventListener !== "function" ||
        typeof walletWindow.dispatchEvent !== "function") return wallets;
    const register = (wallet) => {
        if (wallet && !wallets.includes(wallet)) wallets.push(wallet);
    };
    walletWindow.addEventListener("wallet-standard:register-wallet", (event) => {
        const registerWallet = event.detail;
        if (typeof registerWallet === "function") registerWallet(register);
        else if (typeof registerWallet?.register === "function") registerWallet.register(register);
    });
    walletWindow.dispatchEvent(new CustomEvent("wallet-standard:app-ready", {
        detail: { register }
    }));
    return wallets;
}

function getWalletStandardAdapter(wallet) {
    const existing = walletStandardAdapters.get(wallet);
    if (existing) return existing;
    const adapter = {
        isPhantom: true,
        isWalletStandard: true,
        async connect() {
            const connectFeature = wallet.features["standard:connect"];
            if (typeof connectFeature?.connect !== "function") {
                throw new Error("Phantom does not support the standard wallet connect feature.");
            }
            const result = await connectFeature.connect();
            const account = result.accounts.find((item) =>
                item.chains?.some((chain) => chain.startsWith("solana:"))
            ) ?? result.accounts[0];
            if (!account?.address) throw new Error("Phantom did not return a Solana account.");
            walletStandardAccounts.set(wallet, account);
            return { publicKey: { toString: () => account.address } };
        },
        async signMessage(message) {
            const account = walletStandardAccounts.get(wallet);
            const feature = wallet.features["solana:signMessage"];
            if (!account || typeof feature?.signMessage !== "function") {
                throw new Error("Connect Phantom before signing the wallet ownership message.");
            }
            const [result] = await feature.signMessage({ account, message });
            return { signature: result.signature };
        },
        async signTransaction(transaction, options = {}) {
            const account = walletStandardAccounts.get(wallet);
            const feature = wallet.features["solana:signTransaction"];
            if (!account || typeof feature?.signTransaction !== "function") {
                throw new Error("Phantom does not support Solana transaction signing in this browser.");
            }
            const serializedTransaction = transaction.serialize({
                requireAllSignatures: false,
                verifySignatures: false
            });
            const chain = options.chain === "devnet" ? "solana:devnet" : "solana:mainnet";
            const [result] = await feature.signTransaction({
                account,
                chain,
                transaction: serializedTransaction
            });
            return result.signedTransaction;
        },
        async sendTransaction(transaction, connection, options = {}) {
            const account = walletStandardAccounts.get(wallet);
            if (!account) throw new Error("Connect Phantom before approving a transaction.");
            const chain = options.chain === "devnet" ? "solana:devnet" : "solana:mainnet";
            const serializedTransaction = transaction.serialize({
                requireAllSignatures: false,
                verifySignatures: false
            });
            const sendFeature = wallet.features["solana:signAndSendTransaction"];
            if (typeof sendFeature?.signAndSendTransaction === "function") {
                const [result] = await sendFeature.signAndSendTransaction({
                    account,
                    chain,
                    transaction: serializedTransaction,
                    options: { preflightCommitment: options.preflightCommitment ?? "confirmed" }
                });
                return { signature: encodeBase58(result.signature) };
            }

            const signFeature = wallet.features["solana:signTransaction"];
            if (typeof signFeature?.signTransaction !== "function") {
                throw new Error("Phantom does not support Solana transaction signing in this browser.");
            }
            const [result] = await signFeature.signTransaction({
                account,
                chain,
                transaction: serializedTransaction
            });
            return connection.sendRawTransaction(result.signedTransaction, {
                preflightCommitment: options.preflightCommitment ?? "confirmed"
            });
        }
    };
    walletStandardAdapters.set(wallet, adapter);
    return adapter;
}

export function getPhantomProvider(walletWindow = window) {
    const connection = getWalletConnection(walletWindow);
    if (connection.provider) return connection.provider;
    const injected = walletWindow.phantom?.solana;
    if (injected && typeof injected.connect === "function" &&
        typeof injected.signMessage === "function") return injected;
    const legacy = walletWindow.solana;
    if (legacy?.isPhantom && typeof legacy.connect === "function" &&
        typeof legacy.signMessage === "function") return legacy;
    const wallet = getWalletStandardWallets(walletWindow).find((candidate) =>
        candidate.name === "Phantom" &&
        candidate.chains?.some((chain) => chain.startsWith("solana:"))
    );
    if (wallet) return getWalletStandardAdapter(wallet);
    const mobileSession = readMobileState(walletWindow);
    return mobileSession?.session && mobileSession?.sharedSecret && mobileSession?.walletAddress
        ? createMobileProvider(walletWindow, mobileSession)
        : null;
}

export function getConnectedPhantomWallet(walletWindow = window) {
    const connection = getWalletConnection(walletWindow);
    return connection.provider && connection.publicKey
        ? { provider: connection.provider, publicKey: connection.publicKey }
        : null;
}

export async function signAndBroadcastWithBlockhashRetry({ prepare, build, sign, broadcast }) {
    if ([prepare, build, sign, broadcast].some((operation) => typeof operation !== "function")) {
        throw new TypeError("Blockhash retry requires prepare, build, sign, and broadcast operations.");
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const preparation = await prepare();
        const transaction = await build(preparation, attempt);
        const signedTransaction = await sign(transaction, preparation, attempt);
        try {
            return await broadcast(signedTransaction, preparation, attempt);
        } catch (error) {
            if (error?.code !== "blockhash_expired" || attempt !== 0) throw error;
        }
    }

    throw new Error("The refreshed Solana transaction could not be submitted.");
}

export async function rebuildMobileDepositAfterBlockhashRejection({
    error,
    state,
    prepare,
    build,
    now = Date.now
}) {
    if (error?.code !== "blockhash_expired") throw error;
    if ([prepare, build].some((operation) => typeof operation !== "function")) {
        throw new TypeError("Mobile blockhash recovery requires preparation and transaction-building operations.");
    }
    if (state?.action !== "deposit-sign" || (state.blockhashRetryCount ?? 0) !== 0 ||
        typeof state.paymentIntentId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state.paymentIntentId) ||
        typeof state.paymentIntentAmountRaw !== "string" ||
        state.paymentIntentAmountRaw.length > 20 ||
        !/^[1-9]\d*$/.test(state.paymentIntentAmountRaw) ||
        BigInt(state.paymentIntentAmountRaw) > 18446744073709551615n ||
        !Number.isFinite(Date.parse(state.paymentIntentExpiresAt)) ||
        Date.parse(state.paymentIntentExpiresAt) <= now()) {
        throw new Error("The expired mobile transaction cannot be safely refreshed. Start a new deposit.");
    }
    const preparation = await prepare();
    const transaction = await build(preparation, state);
    return { transaction, blockhashRetryCount: 1 };
}

export function disconnectPhantom(walletWindow = window, provider = null) {
    const connection = getWalletConnection(walletWindow);
    if (!provider || connection.provider === provider) {
        connection.provider = null;
        connection.publicKey = null;
    }
}

export async function connectPhantom(walletWindow = window, timeoutMs = 2000) {
    const connection = getWalletConnection(walletWindow);
    const provider = connection.provider ?? getPhantomProvider(walletWindow) ??
        await waitForPhantomProvider(walletWindow, timeoutMs);
    if (!provider || typeof provider.connect !== "function") return null;
    if (connection.provider === provider && connection.publicKey &&
        provider.isConnected !== false) {
        return { provider, publicKey: connection.publicKey };
    }
    const result = await provider.connect();
    const publicKey = result.publicKey?.toString();
    if (!publicKey) throw new Error("Phantom did not return a connected Solana address.");
    connection.provider = provider;
    connection.publicKey = publicKey;
    if (typeof provider.on === "function" && !connectionListeners.has(provider)) {
        connectionListeners.add(provider);
        provider.on("disconnect", () => disconnectPhantom(walletWindow, provider));
        provider.on("accountChanged", (account) => {
            const updatedAddress = account?.toString();
            if (updatedAddress) connection.publicKey = updatedAddress;
            else disconnectPhantom(walletWindow, provider);
        });
    }
    return { provider, publicKey };
}

export function startPhantomMobileConnect(walletWindow = window, cluster = "mainnet-beta") {
    const target = new URL(walletWindow.location.href);
    if (target.protocol !== "https:") {
        throw new Error("Phantom mobile connection requires the secure production HTTPS site.");
    }
    const nacl = getNacl(walletWindow);
    const keyPair = nacl.box.keyPair();
    const stateBytes = nacl.randomBytes(16);
    const state = Array.from(stateBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    writeMobileState(walletWindow, {
        version: 1,
        state,
        action: "connect",
        publicKey: bytesToBase64(keyPair.publicKey),
        secretKey: bytesToBase64(keyPair.secretKey)
    });
    const url = new URL("https://phantom.com/ul/v1/connect");
    url.searchParams.set("app_url", target.origin);
    url.searchParams.set("dapp_encryption_public_key", encodeBase58(keyPair.publicKey));
    url.searchParams.set("redirect_link", buildCallbackUrl(walletWindow, state));
    if (cluster === "devnet" || cluster === "testnet" || cluster === "mainnet-beta") {
        url.searchParams.set("cluster", cluster);
    }
    walletWindow.location.assign(url.toString());
}

export function readPhantomMobileCallback(walletWindow = window) {
    const url = new URL(walletWindow.location.href);
    if (url.searchParams.get("phantom_callback") !== "1") return null;
    const response = Object.fromEntries(url.searchParams.entries());
    const state = readMobileState(walletWindow);
    const callbackState = url.searchParams.get("phantom_state");
    for (const key of ["phantom_callback", "phantom_state", "data", "nonce",
        "phantom_encryption_public_key", "errorCode", "errorMessage"]) {
        url.searchParams.delete(key);
    }
    walletWindow.history.replaceState({}, "", url.toString());
    if (!state || state.state !== callbackState) {
        walletWindow.localStorage.removeItem(mobileStateKey);
        return { error: new Error("Phantom returned to RelicGrid with an invalid connection state.") };
    }
    return { state, response };
}

export function decryptPhantomMobileResponse(walletWindow, state, response, isConnect = false) {
    const nacl = getNacl(walletWindow);
    if (response.errorCode) {
        throw new Error(response.errorMessage || `Phantom rejected the request (${response.errorCode}).`);
    }
    if (!response.data || !response.nonce) {
        throw new Error("Phantom returned an incomplete encrypted response.");
    }
    let sharedSecret;
    let phantomPublicKey = state.phantomPublicKey;
    if (isConnect) {
        phantomPublicKey = response.phantom_encryption_public_key;
        if (!phantomPublicKey) throw new Error("Phantom did not return its encryption key.");
        sharedSecret = nacl.box.before(
            decodeBase58(phantomPublicKey),
            base64ToBytes(state.secretKey)
        );
    } else {
        if (!state.sharedSecret) throw new Error("The Phantom encrypted session is missing.");
        sharedSecret = base64ToBytes(state.sharedSecret);
    }
    const plaintext = nacl.box.open.after(
        decodeBase58(response.data),
        decodeBase58(response.nonce),
        sharedSecret
    );
    if (!plaintext) throw new Error("Phantom response could not be authenticated.");
    return {
        data: JSON.parse(new TextDecoder().decode(plaintext)),
        sharedSecret: bytesToBase64(sharedSecret),
        phantomPublicKey
    };
}

export function savePhantomMobileSession(walletWindow, state, sessionData) {
    writeMobileState(walletWindow, {
        ...state,
        action: "connected",
        walletAddress: sessionData.walletAddress,
        session: sessionData.session,
        sharedSecret: sessionData.sharedSecret,
        phantomPublicKey: sessionData.phantomPublicKey,
        secretKey: undefined
    });
    mobileProviders.delete(walletWindow);
    const connection = getWalletConnection(walletWindow);
    connection.provider = null;
    connection.publicKey = null;
}

export function clearPhantomMobileSession(walletWindow = window) {
    walletWindow.localStorage.removeItem(mobileStateKey);
    mobileProviders.delete(walletWindow);
    disconnectPhantom(walletWindow);
}

export function setPhantomMobilePendingAction(walletWindow, patch) {
    const state = readMobileState(walletWindow);
    if (!state?.session || !state?.sharedSecret) throw new Error("Connect Phantom before this action.");
    writeMobileState(walletWindow, { ...state, ...patch });
}

export function encodeWalletBytes(bytes) {
    return encodeBase58(bytes);
}

export function decodeWalletBytes(value) {
    return decodeBase58(value);
}

export function bytesToWalletBase64(bytes) {
    return bytesToBase64(bytes);
}

export async function waitForPhantomProvider(walletWindow = window, timeoutMs = 2000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const provider = getPhantomProvider(walletWindow);
        if (provider) return provider;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return getPhantomProvider(walletWindow);
}

export function isMobileBrowser(navigatorObject = navigator) {
    if (navigatorObject.userAgentData?.mobile === true) return true;
    return /Android|iPhone|iPad|iPod/i.test(navigatorObject.userAgent) ||
        (navigatorObject.platform === "MacIntel" && navigatorObject.maxTouchPoints > 1);
}

export function createPhantomBrowseUrl(pageUrl) {
    const target = new URL(pageUrl);
    if (target.protocol !== "https:" || target.username || target.password) {
        throw new Error("Phantom can only open a secure HTTPS RelicGrid page.");
    }
    target.searchParams.set("phantom_handoff", "1");
    return `https://phantom.com/ul/browse/${encodeURIComponent(target.toString())}?ref=${encodeURIComponent(target.origin)}`;
}
