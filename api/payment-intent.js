const { randomUUID } = require("node:crypto");
const {
    authenticate,
    getDepositCreditAmount,
    handleApiCors,
    hasWalletEnvironment,
    parseTokenAmount,
    serviceRequest,
    sendJson
} = require("../server/lib/wallet");
const { isBase58, TOKEN_PROGRAM_IDS } = require("../server/lib/solana-deposit");

const CYFUR_MAINNET_MINT = "9F4hLLngEAhepsH2HLTH6kBYmmq6dzm4GXRrcpME3uam";
const LEGACY_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const INTENT_LIFETIME_MS = 15 * 60 * 1000;

module.exports = async function paymentIntent(request, response) {
    if (handleApiCors(request, response)) return;
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (!hasWalletEnvironment()) {
        return sendJson(response, 503, { error: "wallet_api_not_configured" });
    }

    try {
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });

        const requiredEnvironment = [
            "SUPABASE_SERVICE_ROLE_KEY",
            "SOLANA_TREASURY_ADDRESS",
            "SOLANA_NETWORK"
        ];
        const missing = requiredEnvironment.filter((name) => !process.env[name]?.trim());
        if (missing.length) {
            return sendJson(response, 503, {
                error: "payment_intent_not_configured",
                message: `Payment intents are disabled. Configure server-only ${missing.join(", ")}.`
            });
        }
        const network = process.env.SOLANA_NETWORK;
        if (process.env.WALLET_DIRECT_TREASURY_READY !== "true" ||
            process.env.WALLET_DEPOSITS_ENABLED !== "true" ||
            !["devnet", "mainnet-beta"].includes(network) ||
            (network === "mainnet-beta" && process.env.WALLET_MAINNET_DEPOSITS_ENABLED !== "true")) {
            return sendJson(response, 503, {
                error: "deposits_disabled",
                message: "Deposit intents are disabled by server configuration. Do not send CYFUR."
            });
        }

        const [configs, linkedWallets] = await Promise.all([
            serviceRequest("wallet_system_config?select=deposits_enabled,network,official_mint_address,token_program_id,token_decimals,credits_per_token,rounding_policy,treasury_address&id=eq.1"),
            serviceRequest(`player_solana_wallets?select=wallet_address&player_id=eq.${encodeURIComponent(user.id)}&limit=1`)
        ]);
        const config = configs[0];
        const walletAddress = linkedWallets[0]?.wallet_address;
        if (!config || config.deposits_enabled !== true || config.network !== network ||
            !isBase58(config.official_mint_address, 32) ||
            !TOKEN_PROGRAM_IDS.has(config.token_program_id) ||
            !Number.isInteger(config.token_decimals) ||
            String(config.credits_per_token) !== "10000" ||
            config.rounding_policy !== "floor" ||
            !isBase58(config.treasury_address, 32) ||
            config.treasury_address !== process.env.SOLANA_TREASURY_ADDRESS ||
            (network === "mainnet-beta" &&
                (config.official_mint_address !== CYFUR_MAINNET_MINT ||
                 config.token_program_id !== LEGACY_TOKEN_PROGRAM ||
                 config.token_decimals !== 8))) {
            return sendJson(response, 503, {
                error: "wallet_configuration_incomplete",
                message: "The enabled network, approved CYFUR mint metadata, treasury, and database configuration must match."
            });
        }
        if (!isBase58(walletAddress, 32)) {
            return sendJson(response, 409, {
                error: "solana_wallet_not_linked",
                message: "Connect and verify a Solana wallet before creating a payment intent."
            });
        }

        let amountRaw;
        try {
            amountRaw = parseTokenAmount(request.body?.amount, config.token_decimals);
            getDepositCreditAmount(amountRaw, config.token_decimals, config.rounding_policy);
        } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) {
                return sendJson(response, 400, { error: "invalid_deposit_amount", message: error.message });
            }
            throw error;
        }

        const id = randomUUID();
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + INTENT_LIFETIME_MS);
        await serviceRequest(
            `wallet_payment_intents?status=eq.pending&expires_at=lt.${encodeURIComponent(createdAt.toISOString())}`,
            { method: "DELETE" }
        );
        const intent = {
            id,
            player_id: user.id,
            source_wallet_address: walletAddress,
            network,
            mint_address: config.official_mint_address,
            token_program_id: config.token_program_id,
            treasury_address: config.treasury_address,
            amount_raw: amountRaw,
            token_decimals: config.token_decimals,
            created_at: createdAt.toISOString(),
            expires_at: expiresAt.toISOString(),
            status: "pending"
        };
        const [stored] = await serviceRequest("wallet_payment_intents?select=id,expires_at", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Prefer: "return=representation"
            },
            body: JSON.stringify(intent)
        });
        if (stored?.id !== id || Date.parse(stored?.expires_at) !== expiresAt.getTime()) {
            throw new Error("Payment intent was not persisted exactly as requested.");
        }
        return sendJson(response, 201, {
            intentId: id,
            network,
            sourceWalletAddress: walletAddress,
            mintAddress: config.official_mint_address,
            tokenProgramId: config.token_program_id,
            treasuryAddress: config.treasury_address,
            amountRaw,
            tokenDecimals: config.token_decimals,
            expiresAt: stored.expires_at,
            memo: `RelicGrid payment intent: ${id}`
        });
    } catch (error) {
        console.error("Payment intent creation failed closed.", {
            status: error.status ?? 500,
            code: error.code ?? "payment_intent_creation_failed"
        });
        if (error.status === 404 && error.code === "PGRST205") {
            return sendJson(response, 503, { error: "payment_intent_migration_required" });
        }
        return sendJson(response, 502, { error: "payment_intent_unavailable" });
    }
};
