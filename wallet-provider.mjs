const walletStandardRegistries = new WeakMap();
const walletStandardAccounts = new WeakMap();
const walletStandardAdapters = new WeakMap();

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

export function getPhantomProvider(walletWindow = window) {
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
    return wallet ? getWalletStandardAdapter(wallet) : null;
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
        throw new Error("Phantom can only open a secure HTTPS FluxGrid page.");
    }
    target.searchParams.set("phantom_handoff", "1");
    return `https://phantom.com/ul/browse/${encodeURIComponent(target.toString())}?ref=${encodeURIComponent(target.origin)}`;
}
