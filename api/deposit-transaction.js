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
            const signature = await solanaRpc(process.env.SOLANA_RPC_URL, "sendTransaction", [
                transaction.toString("base64"),
                {
                    encoding: "base64",
                    preflightCommitment: "confirmed",
                    minContextSlot
                }
            ]);
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
