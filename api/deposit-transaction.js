const {
    authenticate,
    handleApiCors,
    hasWalletEnvironment,
    serviceRequest,
    sendJson
} = require("../server/lib/wallet");
const {
    GENESIS_HASHES,
    TOKEN_PROGRAM_IDS,
    isBase58,
    sanitizeRpcErrorData,
    sanitizeRpcErrorMessage,
    solanaRpc
} = require("../server/lib/solana-deposit");

function notReady(response, error, message) {
    return sendJson(response, 503, { error, message });
}

function getTokenAccountAddresses(result) {
    if (!Array.isArray(result?.value)) {
        throw new Error("The configured Solana RPC returned an invalid token-account response.");
    }
    return result.value.map((account) => {
        if (!isBase58(account?.pubkey, 32)) {
            throw new Error("The configured Solana RPC returned an invalid token-account address.");
        }
        return account.pubkey;
    });
}

function decodeSignedTransaction(value) {
    if (typeof value !== "string" || value.length > 1644 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        return null;
    }
    const transaction = Buffer.from(value, "base64");
    if (transaction.length === 0 || transaction.length > 1232 ||
        transaction.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
        return null;
    }
    return transaction;
}

function readShortVec(bytes, offset) {
    let value = 0;
    let shift = 0;
    let cursor = offset;
    while (cursor < bytes.length && shift <= 14) {
        const byte = bytes[cursor];
        value |= (byte & 0x7f) << shift;
        cursor += 1;
        if ((byte & 0x80) === 0) return { value, offset: cursor };
        shift += 7;
    }
    return null;
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

function inspectLegacyTransaction(transaction) {
    const signatureCount = readShortVec(transaction, 0);
    if (!signatureCount) return null;
    const messageOffset = signatureCount.offset + signatureCount.value * 64;
    if (messageOffset >= transaction.length) return null;
    const message = transaction.subarray(messageOffset);
    if (message[0] & 0x80) return null;

    let offset = 3;
    const keyCount = readShortVec(message, offset);
    if (!keyCount) return null;
    offset = keyCount.offset;
    const accountKeys = [];
    for (let index = 0; index < keyCount.value; index += 1) {
        if (offset + 32 > message.length) return null;
        accountKeys.push(message.subarray(offset, offset + 32));
        offset += 32;
    }
    if (offset + 32 > message.length) return null;
    offset += 32;

    const instructionCount = readShortVec(message, offset);
    if (!instructionCount) return null;
    offset = instructionCount.offset;
    const instructionRoles = [];
    let associatedTokenAccountCreateCount = 0;
    let sourceTokenAccount;
    let treasuryTokenAccount;

    for (let index = 0; index < instructionCount.value; index += 1) {
        if (offset >= message.length) return null;
        const programIndex = message[offset];
        offset += 1;
        const accountIndexCount = readShortVec(message, offset);
        if (!accountIndexCount) return null;
        offset = accountIndexCount.offset;
        const accountIndexes = message.subarray(offset, offset + accountIndexCount.value);
        if (accountIndexes.length !== accountIndexCount.value ||
            [...accountIndexes].some((accountIndex) => accountIndex >= accountKeys.length)) return null;
        offset += accountIndexCount.value;
        const dataLength = readShortVec(message, offset);
        if (!dataLength) return null;
        offset = dataLength.offset;
        const data = message.subarray(offset, offset + dataLength.value);
        if (data.length !== dataLength.value || programIndex >= accountKeys.length) return null;
        offset += dataLength.value;

        const programId = encodeBase58(accountKeys[programIndex]);
        if (programId === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" &&
            (data[0] === 0 || data[0] === 1)) {
            instructionRoles.push("associated_token_account_create");
            associatedTokenAccountCreateCount += 1;
        } else if (programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
            data[0] === 12) {
            instructionRoles.push("spl_token_transfer_checked");
            if (accountIndexes.length >= 3) {
                sourceTokenAccount = encodeBase58(accountKeys[accountIndexes[0]]);
                treasuryTokenAccount = encodeBase58(accountKeys[accountIndexes[2]]);
            }
        } else if (programId === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr") {
            instructionRoles.push("memo");
        } else {
            instructionRoles.push("other");
        }
    }

    return {
        message,
        instructionRoles,
        associatedTokenAccountCreateCount,
        sourceTokenAccount,
        treasuryTokenAccount
    };
}

async function logSimulationFundingDiagnostics({
    transaction,
    payer,
    treasuryOwner,
    mint,
    tokenProgramId,
    expectedAmountRaw,
    rpcUrl
}) {
    const inspected = inspectLegacyTransaction(transaction);
    const diagnosticRpc = async (method, params) => {
        try {
            return await solanaRpc(rpcUrl, method, params);
        } catch (error) {
            console.error("Solana funding diagnostic RPC failed.", {
                method,
                rpcCode: Number.isInteger(error.rpcCode) ? error.rpcCode : null,
                rpcMessage: sanitizeRpcErrorMessage(error.rpcMessage || error.message)
            });
            return null;
        }
    };
    const requests = [
        diagnosticRpc("getBalance", [payer, { commitment: "confirmed" }]),
        diagnosticRpc("getMinimumBalanceForRentExemption", [165, { commitment: "confirmed" }]),
        diagnosticRpc("getFeeForMessage", [
            inspected?.message.toString("base64") ?? "",
            { commitment: "confirmed" }
        ]),
        inspected?.sourceTokenAccount
            ? diagnosticRpc("getAccountInfo", [
                inspected.sourceTokenAccount,
                { commitment: "confirmed", encoding: "jsonParsed" }
            ])
            : Promise.resolve(null),
        inspected?.treasuryTokenAccount
            ? diagnosticRpc("getAccountInfo", [
                inspected.treasuryTokenAccount,
                { commitment: "confirmed", encoding: "jsonParsed" }
            ])
            : Promise.resolve(null)
    ];
    const [balance, rent, fee, source, treasury] = await Promise.all(requests);
    const payerLamports = Number.isSafeInteger(balance) && balance >= 0 ? balance : null;
    const rentLamports = Number.isSafeInteger(rent) && rent >= 0 ? rent : null;
    const feeLamports = Number.isSafeInteger(fee?.value) && fee.value >= 0
        ? fee.value
        : null;
    const requiredRentLamports = rentLamports === null || !inspected
        ? null
        : rentLamports * inspected.associatedTokenAccountCreateCount;
    const requiredTotalLamports = feeLamports === null || requiredRentLamports === null
        ? null
        : feeLamports + requiredRentLamports;
    const sourceInfo = source?.value?.data?.parsed?.info;
    const treasuryInfo = treasury?.value?.data?.parsed?.info;
    const sourceAmountText = String(sourceInfo?.tokenAmount?.amount ?? "");
    const sourceAmount = sourceAmountText.length <= 20 && /^\d+$/.test(sourceAmountText)
        ? BigInt(sourceInfo.tokenAmount.amount)
        : null;
    let expectedAmount = null;
    try {
        if (/^[1-9]\d*$/.test(String(expectedAmountRaw))) {
            expectedAmount = BigInt(expectedAmountRaw);
        }
    } catch {
        expectedAmount = null;
    }

    console.info("Deposit transaction simulation funding diagnostics.", {
        instructionRoles: inspected?.instructionRoles ?? null,
        associatedTokenAccountCreateCount: inspected?.associatedTokenAccountCreateCount ?? null,
        payerLamports,
        transactionFeeLamports: feeLamports,
        tokenAccountRentLamports: rentLamports,
        requiredRentLamports,
        requiredTotalLamports,
        payerBalanceCoversFeeAndRent: payerLamports !== null &&
            requiredTotalLamports !== null &&
            payerLamports >= requiredTotalLamports,
        sourceTokenAccountExists: Boolean(source?.value),
        sourceTokenAccountOwnerMatchesPayer: sourceInfo?.owner === payer,
        sourceTokenAccountMintMatchesIntent: sourceInfo?.mint === mint,
        sourceTokenAccountProgramMatchesConfig: source?.value?.owner === tokenProgramId,
        sourceTokenAmountCoversIntent: sourceAmount !== null &&
            expectedAmount !== null &&
            sourceAmount >= expectedAmount,
        treasuryTokenAccountExists: Boolean(treasury?.value),
        treasuryTokenAccountOwnerMatchesTreasury: treasuryInfo?.owner === treasuryOwner,
        treasuryTokenAccountMintMatchesIntent: treasuryInfo?.mint === mint,
        treasuryTokenAccountProgramMatchesConfig: treasury?.value?.owner === tokenProgramId
    });
}

module.exports = async function depositTransaction(request, response) {
    let stage = "request_validation";
    if (handleApiCors(request, response)) return;
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (!hasWalletEnvironment()) {
        return sendJson(response, 503, { error: "wallet_api_not_configured" });
    }

    try {
        stage = "authentication";
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });

        const missing = [
            "SUPABASE_SERVICE_ROLE_KEY",
            "SOLANA_RPC_URL",
            "SOLANA_TREASURY_ADDRESS"
        ].filter((name) => !process.env[name]?.trim());
        if (missing.length) {
            return notReady(
                response,
                "wallet_verifier_not_configured",
                `Deposit preparation is disabled. Configure server-only ${missing.join(", ")}.`
            );
        }
        if (process.env.WALLET_DIRECT_TREASURY_READY !== "true") {
            return notReady(response, "direct_treasury_not_ready", "Direct treasury deposits are not approved.");
        }
        const network = process.env.SOLANA_NETWORK;
        if (process.env.WALLET_DEPOSITS_ENABLED !== "true" ||
            !["devnet", "mainnet-beta"].includes(network)) {
            return notReady(response, "deposits_disabled", "Deposit preparation is disabled by server configuration.");
        }
        if (network === "mainnet-beta" && process.env.WALLET_MAINNET_DEPOSITS_ENABLED !== "true") {
            return notReady(response, "mainnet_deposits_disabled", "Mainnet deposits are not enabled.");
        }

        stage = "database_configuration";
        const [configs, linkedWallets] = await Promise.all([
            serviceRequest("wallet_system_config?select=deposits_enabled,network,official_mint_address,token_program_id,token_decimals,credits_per_token,rounding_policy,treasury_address&id=eq.1"),
            serviceRequest(`player_solana_wallets?select=wallet_address&player_id=eq.${encodeURIComponent(user.id)}&limit=1`)
        ]);
        const config = configs[0];
        const linkedWallet = linkedWallets[0]?.wallet_address;
        if (!config || config.deposits_enabled !== true || config.network !== network ||
            !isBase58(config.official_mint_address, 32) ||
            !TOKEN_PROGRAM_IDS.has(config.token_program_id) ||
            !Number.isInteger(config.token_decimals) ||
            String(config.credits_per_token) !== "10000" ||
            config.rounding_policy !== "floor" ||
            !isBase58(config.treasury_address, 32) ||
            config.treasury_address !== process.env.SOLANA_TREASURY_ADDRESS) {
            return notReady(response, "wallet_configuration_incomplete", "Deposit configuration is not ready.");
        }
        if (!isBase58(linkedWallet, 32)) {
            return sendJson(response, 409, {
                error: "solana_wallet_not_linked",
                message: "Connect and verify the wallet linked to this game account."
            });
        }

        const action = request.body?.action;
        if (action === "prepare") {
            stage = "prepare_rpc";
            const [genesisHash, senderAccounts, treasuryAccounts] = await Promise.all([
                solanaRpc(process.env.SOLANA_RPC_URL, "getGenesisHash", []),
                solanaRpc(process.env.SOLANA_RPC_URL, "getTokenAccountsByOwner", [
                    linkedWallet,
                    { mint: config.official_mint_address },
                    { commitment: "confirmed", encoding: "jsonParsed" }
                ]),
                solanaRpc(process.env.SOLANA_RPC_URL, "getTokenAccountsByOwner", [
                    config.treasury_address,
                    { mint: config.official_mint_address },
                    { commitment: "confirmed", encoding: "jsonParsed" }
                ])
            ]);
            if (genesisHash !== GENESIS_HASHES[network]) {
                return notReady(response, "solana_rpc_network_mismatch", "Configured Solana RPC is connected to a different network.");
            }
            const latestBlockhash = await solanaRpc(process.env.SOLANA_RPC_URL, "getLatestBlockhash", [
                { commitment: "confirmed" }
            ]);
            const blockhash = latestBlockhash?.value?.blockhash;
            if (!isBase58(blockhash, 32) ||
                !Number.isSafeInteger(latestBlockhash?.value?.lastValidBlockHeight)) {
                throw new Error("The configured Solana RPC returned an invalid recent blockhash.");
            }
            return sendJson(response, 200, {
                blockhash,
                lastValidBlockHeight: latestBlockhash.value.lastValidBlockHeight,
                senderTokenAccounts: getTokenAccountAddresses(senderAccounts),
                treasuryTokenAccounts: getTokenAccountAddresses(treasuryAccounts)
            });
        }

        if (action === "broadcast") {
            stage = "broadcast_payload_validation";
            const paymentIntentId = request.body?.paymentIntentId;
            if (typeof paymentIntentId !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentIntentId)) {
                return sendJson(response, 400, { error: "payment_intent_required" });
            }
            const transaction = decodeSignedTransaction(request.body?.transaction);
            if (!transaction) {
                return sendJson(response, 400, { error: "invalid_signed_transaction" });
            }
            stage = "broadcast_payment_intent";
            const [intent] = await serviceRequest(
                `wallet_payment_intents?select=id,player_id,source_wallet_address,network,mint_address,token_program_id,treasury_address,amount_raw,token_decimals,expires_at,status&id=eq.${encodeURIComponent(paymentIntentId)}&player_id=eq.${encodeURIComponent(user.id)}&limit=1`
            );
            const intentExpiresAt = Date.parse(intent?.expires_at);
            const intentAmount = String(intent?.amount_raw ?? "");
            if (!intent ||
                intent.player_id !== user.id ||
                intent.source_wallet_address !== linkedWallet ||
                intent.network !== config.network ||
                intent.mint_address !== config.official_mint_address ||
                intent.token_program_id !== config.token_program_id ||
                intent.treasury_address !== config.treasury_address ||
                intent.token_decimals !== config.token_decimals ||
                !/^[1-9]\d*$/.test(intentAmount) ||
                intentAmount.length > 20 ||
                BigInt(intentAmount) > 18446744073709551615n ||
                !Number.isFinite(intentExpiresAt) ||
                intentExpiresAt <= Date.now() ||
                intent.status !== "pending") {
                return sendJson(response, 409, {
                    error: "payment_intent_invalid_or_expired",
                    message: "The payment intent is no longer valid. No transaction was submitted."
                });
            }
            stage = "broadcast_rpc_context";
            const [genesisHash, minContextSlot] = await Promise.all([
                solanaRpc(process.env.SOLANA_RPC_URL, "getGenesisHash", []),
                solanaRpc(process.env.SOLANA_RPC_URL, "getSlot", [
                    { commitment: "confirmed" }
                ])
            ]);
            if (genesisHash !== GENESIS_HASHES[network]) {
                return notReady(response, "solana_rpc_network_mismatch", "Configured Solana RPC is connected to a different network.");
            }
            if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0) {
                throw new Error("The configured Solana RPC returned an invalid current slot.");
            }
            stage = "broadcast_rpc_send";
            const signedTransactionBase64 = transaction.toString("base64");
            let signature;
            try {
                signature = await solanaRpc(process.env.SOLANA_RPC_URL, "sendTransaction", [
                    signedTransactionBase64,
                    {
                        encoding: "base64",
                        preflightCommitment: "confirmed",
                        minContextSlot
                    }
                ]);
            } catch (error) {
                if (error.rpcCode === -32002) {
                    try {
                        await logSimulationFundingDiagnostics({
                            transaction,
                            payer: linkedWallet,
                            treasuryOwner: config.treasury_address,
                            mint: config.official_mint_address,
                            tokenProgramId: config.token_program_id,
                            expectedAmountRaw: intentAmount,
                            rpcUrl: process.env.SOLANA_RPC_URL
                        });
                    } catch (diagnosticError) {
                        console.error("Deposit simulation diagnostics failed.", {
                            errorName: diagnosticError?.name || "Error",
                            errorMessage: sanitizeRpcErrorMessage(
                                diagnosticError?.message || "Unknown diagnostic error"
                            )
                        });
                    }
                }
                if (error.rpcCode !== -32016 ||
                    !/minimum context slot has not been reached/i.test(error.rpcMessage ?? "")) {
                    throw error;
                }
                console.warn("Solana RPC has not reached the requested broadcast context slot; retrying with preflight enabled.", {
                    stage,
                    rpcCode: error.rpcCode,
                    rpcMessage: sanitizeRpcErrorMessage(error.rpcMessage),
                    minContextSlot
                });
                stage = "broadcast_rpc_send_context_fallback";
                signature = await solanaRpc(process.env.SOLANA_RPC_URL, "sendTransaction", [
                    signedTransactionBase64,
                    {
                        encoding: "base64",
                        preflightCommitment: "confirmed"
                    }
                ]);
            }
            if (!isBase58(signature, 64)) {
                throw new Error("The configured Solana RPC returned an invalid transaction signature.");
            }
            return sendJson(response, 200, { signature });
        }

        return sendJson(response, 400, { error: "invalid_action" });
    } catch (error) {
        const blockhashExpired = error.rpcCode === -32002 &&
            /blockhash not found/i.test(error.rpcMessage ?? "");
        console.error("Deposit transaction request failed.", {
            stage,
            status: error.status ?? (blockhashExpired ? 409 : 502),
            errorName: error.name || "Error",
            errorMessage: blockhashExpired
                ? "Solana RPC sendTransaction failed: blockhash not found."
                : sanitizeRpcErrorMessage(error.message || "Unknown error"),
            rpcCode: Number.isInteger(error.rpcCode) ? error.rpcCode : null,
            rpcMessage: sanitizeRpcErrorMessage(error.rpcMessage),
            rpcData: sanitizeRpcErrorData(error.rpcData),
            rpcForbidden: error.message?.includes("(403)") === true
        });
        if (blockhashExpired) {
            return sendJson(response, 409, {
                error: "blockhash_expired",
                message: "The Solana RPC rejected this blockhash. Refresh the transaction and approve the new transaction in Phantom."
            });
        }
        const forbidden = error.message?.includes("(403)") === true;
        return sendJson(response, 502, {
            error: forbidden ? "solana_rpc_forbidden" : "solana_rpc_unavailable",
            message: forbidden
                ? "The configured server Solana RPC returned HTTP 403. Check the provider's API access and network permissions; no transaction was submitted."
                : "The configured server Solana RPC could not prepare or submit this transaction. No credits will be added unless the deposit verifier confirms it."
        });
    }
};
