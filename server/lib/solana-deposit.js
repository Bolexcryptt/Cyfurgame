const TOKEN_PROGRAM_IDS = new Set([
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);
const GENESIS_HASHES = {
    "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
};
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function isBase58(value, expectedBytes) {
    if (typeof value !== "string" || value.length < 32 || value.length > 100) return false;
    let decoded = 0n;
    for (const character of value) {
        const digit = BASE58_ALPHABET.indexOf(character);
        if (digit < 0) return false;
        decoded = decoded * 58n + BigInt(digit);
    }
    let byteLength = 0;
    for (let remaining = decoded; remaining > 0n; remaining >>= 8n) byteLength += 1;
    for (const character of value) {
        if (character !== "1") break;
        byteLength += 1;
    }
    return byteLength === expectedBytes;
}

function getPublicKey(key) {
    return typeof key === "string" ? key : key?.pubkey;
}

function getInstructionAmount(info) {
    const amount = info?.amount ?? info?.tokenAmount?.amount;
    return typeof amount === "string" && /^\d+$/.test(amount) ? BigInt(amount) : null;
}

function decodeBase58(value) {
    let decoded = 0n;
    for (const character of value) {
        const digit = BASE58_ALPHABET.indexOf(character);
        if (digit < 0) return null;
        decoded = decoded * 58n + BigInt(digit);
    }
    const bytes = [];
    while (decoded > 0n) {
        bytes.unshift(Number(decoded & 0xffn));
        decoded >>= 8n;
    }
    for (const character of value) {
        if (character !== "1") break;
        bytes.unshift(0);
    }
    return Uint8Array.from(bytes);
}

function sanitizeRpcErrorMessage(message) {
    if (typeof message !== "string") return "Unknown RPC error";
    const programLabels = [
        ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "[spl-token-program]"],
        ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "[associated-token-program]"],
        ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "[memo-program]"],
        ["ComputeBudget111111111111111111111111111111", "[compute-budget-program]"],
        ["11111111111111111111111111111111", "[system-program]"]
    ];
    let sanitized = message;
    for (const [programId, label] of programLabels) {
        sanitized = sanitized.replaceAll(programId, label);
    }
    return sanitized
        .replace(/https?:\/\/\S+/gi, "[redacted-url]")
        .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "[redacted-address]")
        .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "[redacted-data]")
        .slice(0, 300);
}

function sanitizeRpcErrorData(data) {
    if (!data || typeof data !== "object") return null;
    const details = {};
    if (Object.prototype.hasOwnProperty.call(data, "err")) {
        if (typeof data.err === "string") {
            details.err = sanitizeRpcErrorMessage(data.err);
        } else {
            let serializedError;
            try {
                serializedError = JSON.stringify(data.err);
            } catch {
                serializedError = "Unserializable RPC simulation error";
            }
            details.err = sanitizeRpcErrorMessage(serializedError);
        }
    }
    if (Array.isArray(data.logs)) {
        details.logs = data.logs.slice(0, 20).map((line) =>
            sanitizeRpcErrorMessage(line)
        );
        details.omittedLogCount = Math.max(0, data.logs.length - 20);
    }
    if (Number.isSafeInteger(data.unitsConsumed) && data.unitsConsumed >= 0) {
        details.unitsConsumed = data.unitsConsumed;
    }
    if (Number.isSafeInteger(data.accountCount) && data.accountCount >= 0) {
        details.accountCount = data.accountCount;
    } else if (Array.isArray(data.accounts)) {
        details.accountCount = data.accounts.length;
    }
    return details;
}

async function solanaRpc(rpcUrl, method, params, fetchImpl = fetch) {
    let response;

    try {
        response = await fetchImpl(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            cache: "no-store"
        });
    } catch (error) {
        console.error("Solana RPC connection failed.", {
            method,
            errorName: error?.name || "Error",
            errorMessage: sanitizeRpcErrorMessage(error?.message || "Unknown error"),
            errorCause: error?.cause?.message
                ? sanitizeRpcErrorMessage(error.cause.message)
                : null,
            errorCode: error?.cause?.code || null
        });
        throw new Error(`Solana RPC ${method} connection failed.`);
    }

    if (!response.ok) {
        console.error("Solana RPC HTTP error.", {
            method,
            status: response.status
        });
        throw new Error(`Solana RPC request failed (${response.status}).`);
    }

    let payload;

    try {
        payload = await response.json();
    } catch {
        console.error("Solana RPC returned invalid JSON.", { method });
        throw new Error(`Solana RPC ${method} returned invalid JSON.`);
    }

    if (payload?.error) {
        const rpcMessage = typeof payload.error.message === "string"
            ? payload.error.message
            : "";
        console.error("Solana JSON-RPC error.", {
            method,
            code: Number.isInteger(payload.error.code)
                ? payload.error.code
                : null,
            message: sanitizeRpcErrorMessage(rpcMessage),
            data: sanitizeRpcErrorData(payload.error.data)
        });

        const error = new Error(`Solana RPC ${method} failed.`);
        error.rpcCode = Number.isInteger(payload.error.code) ? payload.error.code : null;
        error.rpcMessage = sanitizeRpcErrorMessage(rpcMessage);
        error.rpcData = sanitizeRpcErrorData(payload.error.data);
        throw error;
    }

    if (!Object.prototype.hasOwnProperty.call(payload ?? {}, "result")) {
        console.error("Solana RPC response missing result.", { method });
        throw new Error(`Solana RPC ${method} returned no result.`);
    }

    return payload.result;
}

async function verifyFinalizedDeposit({
    signature,
    depositAddress,
    expectedSourceWallet,
    officialMint,
    tokenProgramId,
    tokenDecimals,
    network,
    rpcUrl,
    expectedAmountRaw,
    requiredMemo,
    fetchImpl = fetch
}) {
    if (!isBase58(signature, 64)) throw new TypeError("Invalid Solana transaction signature.");
    if (!isBase58(depositAddress, 32) || !isBase58(officialMint, 32)) {
        throw new TypeError("Invalid configured Solana address.");
    }
    if (expectedSourceWallet !== undefined && !isBase58(expectedSourceWallet, 32)) {
        throw new TypeError("Invalid expected Solana sender address.");
    }
    if (!TOKEN_PROGRAM_IDS.has(tokenProgramId)) {
        throw new TypeError("Unsupported configured Solana token program.");
    }
    if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
        throw new TypeError("Invalid configured token decimals.");
    }
    if (!GENESIS_HASHES[network]) throw new TypeError("Unsupported Solana network.");
    if (typeof rpcUrl !== "string" || !/^https:\/\//i.test(rpcUrl)) {
        throw new TypeError("A trusted HTTPS Solana RPC URL is required.");
    }
    if (expectedAmountRaw !== undefined &&
        (typeof expectedAmountRaw !== "string" || !/^[1-9]\d*$/.test(expectedAmountRaw))) {
        throw new TypeError("Invalid expected token transfer amount.");
    }
    if (requiredMemo !== undefined &&
        (typeof requiredMemo !== "string" || requiredMemo.length < 1 || requiredMemo.length > 128)) {
        throw new TypeError("Invalid required payment-intent memo.");
    }

    const genesisHash = await solanaRpc(rpcUrl, "getGenesisHash", [], fetchImpl);
    if (genesisHash !== GENESIS_HASHES[network]) {
        throw new Error("Configured Solana RPC endpoint is connected to a different network.");
    }
    const signatureStatus = await solanaRpc(rpcUrl, "getSignatureStatuses", [[signature], {
        searchTransactionHistory: true
    }], fetchImpl);
    const status = signatureStatus?.value?.[0];
    if (!status) return { state: "not_found" };
    if (status.err) return { state: "failed" };
    if (status.confirmationStatus !== "finalized") return { state: "pending" };

    const [transaction, mintAccount] = await Promise.all([
        solanaRpc(rpcUrl, "getTransaction", [signature, {
            commitment: "finalized",
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0
        }], fetchImpl),
        solanaRpc(rpcUrl, "getAccountInfo", [officialMint, {
            commitment: "finalized",
            encoding: "jsonParsed"
        }], fetchImpl)
    ]);
    if (!transaction || !mintAccount?.value) return { state: "unavailable" };
    if (transaction.meta?.err || !Number.isSafeInteger(transaction.slot) ||
        !transaction.transaction?.signatures?.includes(signature)) {
        return { state: "failed" };
    }

    const mintInfo = mintAccount.value.data?.parsed?.info;
    if (mintAccount.value.owner !== tokenProgramId ||
        mintInfo?.decimals !== tokenDecimals ||
        mintAccount.value.data?.parsed?.type !== "mint") {
        throw new Error("Configured mint, token program, or decimals do not match finalized on-chain mint data.");
    }

    const pre = new Map((transaction.meta.preTokenBalances ?? []).map((entry) => [
        `${entry.accountIndex}:${entry.mint}`,
        { amount: BigInt(entry.uiTokenAmount.amount), owner: entry.owner }
    ]));
    const recipientAccounts = new Set();
    const sourceAccounts = new Set();
    const transactionSigners = new Set(
        (transaction.transaction.message.accountKeys ?? [])
            .filter((key) => key?.signer === true)
            .map(getPublicKey)
            .filter(Boolean)
    );
    let receivedAmount = 0n;
    if (expectedSourceWallet !== undefined) {
        for (const entry of [
            ...(transaction.meta.preTokenBalances ?? []),
            ...(transaction.meta.postTokenBalances ?? [])
        ]) {
            if (entry.mint !== officialMint || entry.owner !== expectedSourceWallet) continue;
            const tokenAccount = getPublicKey(
                transaction.transaction.message.accountKeys[entry.accountIndex]
            );
            if (tokenAccount) sourceAccounts.add(tokenAccount);
        }
    }
    for (const entry of transaction.meta.postTokenBalances ?? []) {
        if (entry.mint !== officialMint || entry.owner !== depositAddress) continue;
        const key = `${entry.accountIndex}:${entry.mint}`;
        const previous = pre.get(key);
        const previousAmount = previous?.owner === depositAddress ? previous.amount : 0n;
        const delta = BigInt(entry.uiTokenAmount.amount) - previousAmount;
        if (delta > 0n) {
            receivedAmount += delta;
            const accountKey = transaction.transaction.message.accountKeys[entry.accountIndex];
            const tokenAccount = getPublicKey(accountKey);
            if (tokenAccount) recipientAccounts.add(tokenAccount);
        }
    }
    if (receivedAmount <= 0n) return { state: "wrong_destination_or_token" };

    const instructions = [
        ...(transaction.transaction.message.instructions ?? []),
        ...(transaction.meta.innerInstructions ?? []).flatMap((group) => group.instructions ?? [])
    ];
    if (requiredMemo !== undefined) {
        const memoProgramId = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
        const memoBytes = new TextEncoder().encode(requiredMemo);
        const hasIntentMemo = instructions.some((instruction) => {
            if (getPublicKey(instruction.programId) !== memoProgramId) return false;
            if (instruction.parsed === requiredMemo || instruction.parsed?.info === requiredMemo) return true;
            const encoded = typeof instruction.data === "string"
                ? decodeBase58(instruction.data)
                : null;
            return encoded !== null &&
                Buffer.from(encoded).equals(Buffer.from(memoBytes));
        });
        if (!hasIntentMemo) return { state: "payment_intent_mismatch" };
    }
    let instructionAmount = 0n;
    const sourceWallets = new Set();
    for (const instruction of instructions) {
        if (getPublicKey(instruction.programId) !== tokenProgramId ||
            !["transfer", "transferChecked"].includes(instruction.parsed?.type)) continue;
        const info = instruction.parsed.info;
        if (!recipientAccounts.has(info?.destination)) continue;
        if (expectedSourceWallet !== undefined &&
            (!sourceAccounts.has(info?.source) || info?.authority !== expectedSourceWallet)) {
            return { state: "wrong_destination_or_token" };
        }
        if (!isBase58(info?.authority, 32) || !transactionSigners.has(info.authority)) {
            return { state: "wrong_destination_or_token" };
        }
        if (info.mint && info.mint !== officialMint) {
            throw new Error("Transaction contains a transfer of a different token mint.");
        }
        const amount = getInstructionAmount(info);
        if (amount === null || amount <= 0n) throw new Error("Transaction contains an invalid token transfer amount.");
        instructionAmount += amount;
        sourceWallets.add(info.authority);
    }
    if (instructionAmount !== receivedAmount || sourceWallets.size !== 1) {
        return { state: "wrong_destination_or_token" };
    }
    if (expectedAmountRaw !== undefined && receivedAmount !== BigInt(expectedAmountRaw)) {
        return { state: "wrong_amount" };
    }

    return {
        state: "finalized",
        amountRaw: receivedAmount.toString(),
        sourceWalletAddress: [...sourceWallets][0],
        finalizedSlot: transaction.slot,
        finalizedAt: transaction.blockTime
    };
}

module.exports = {
    GENESIS_HASHES,
    TOKEN_PROGRAM_IDS,
    isBase58,
    sanitizeRpcErrorMessage,
    sanitizeRpcErrorData,
    solanaRpc,
    verifyFinalizedDeposit
};
