const { randomUUID } = require("node:crypto");
const {
    authenticate,
    getDepositCreditAmount,
    handleApiCors,
    hasWalletEnvironment,
    serviceRequest,
    sendJson
} = require("../server/lib/wallet");
const {
    deriveAssociatedTokenAccount,
    GENESIS_HASHES,
    isOfficialCyfurMintAccount,
    isBase58,
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS,
    solanaRpc,
    TOKEN_PROGRAM_IDS
} = require("../server/lib/solana-deposit");

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
            "SOLANA_RPC_URL",
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

        const configs = await serviceRequest(
            "wallet_system_config?select=deposits_enabled,network,official_mint_address,token_program_id,token_decimals,credits_per_token,rounding_policy,treasury_address&id=eq.1"
        );
        const config = configs[0];
        if (!config || config.deposits_enabled !== true || config.network !== network ||
            !isBase58(config.official_mint_address, 32) ||
            config.official_mint_address !== RELICGRID_CYFUR_MINT_ADDRESS ||
            !TOKEN_PROGRAM_IDS.has(config.token_program_id) ||
            !Number.isInteger(config.token_decimals) ||
            String(config.credits_per_token) !== "10000" ||
            config.rounding_policy !== "floor" ||
            !isBase58(config.treasury_address, 32) ||
            config.treasury_address !== RELICGRID_TREASURY_ADDRESS ||
            config.treasury_address !== process.env.SOLANA_TREASURY_ADDRESS ||
            (network === "mainnet-beta" && config.token_decimals !== 8)) {
            return sendJson(response, 503, {
                error: "wallet_configuration_incomplete",
                message: "The enabled network, approved CYFUR mint metadata, treasury, and database configuration must match."
            });
        }
        const treasuryTokenAccount = deriveAssociatedTokenAccount(
            config.treasury_address,
            config.official_mint_address,
            config.token_program_id
        );
        const [genesisHash, treasuryAccount, mintAccount, treasuryTokenAccountInfo] =
            await Promise.all([
                solanaRpc(process.env.SOLANA_RPC_URL, "getGenesisHash", []),
                solanaRpc(process.env.SOLANA_RPC_URL, "getAccountInfo", [
                    config.treasury_address,
                    { commitment: "finalized", encoding: "base64" }
                ]),
                solanaRpc(process.env.SOLANA_RPC_URL, "getAccountInfo", [
                    config.official_mint_address,
                    { commitment: "finalized", encoding: "jsonParsed" }
                ]),
                solanaRpc(process.env.SOLANA_RPC_URL, "getAccountInfo", [
                    treasuryTokenAccount,
                    { commitment: "finalized", encoding: "jsonParsed" }
                ])
            ]);
        const treasuryTokenInfo = treasuryTokenAccountInfo?.value?.data?.parsed?.info;
        if (genesisHash !== GENESIS_HASHES[network] ||
            (treasuryAccount?.value &&
                treasuryAccount.value.owner !== "11111111111111111111111111111111") ||
            !isOfficialCyfurMintAccount(mintAccount) ||
            config.token_program_id !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
            config.token_decimals !== 8 ||
            !treasuryTokenAccountInfo?.value ||
            treasuryTokenAccountInfo.value.owner !== config.token_program_id ||
            treasuryTokenAccountInfo.value.data?.parsed?.type !== "account" ||
            treasuryTokenInfo?.mint !== config.official_mint_address ||
            treasuryTokenInfo?.owner !== config.treasury_address) {
            return sendJson(response, 503, {
                error: "wallet_configuration_incomplete",
                message: "Finalized Solana mainnet account checks for the CYFUR mint and treasury associated token account did not pass."
            });
        }
        if (request.body?.action === "validate") {
            const paymentIntentId = request.body?.paymentIntentId;
            if (typeof paymentIntentId !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentIntentId)) {
                return sendJson(response, 400, { error: "payment_intent_required" });
            }
            const [storedIntent] = await serviceRequest(
                `wallet_payment_intents?select=id,player_id,network,mint_address,token_program_id,treasury_address,amount_raw,token_decimals,expires_at,status&id=eq.${encodeURIComponent(paymentIntentId)}&player_id=eq.${encodeURIComponent(user.id)}&limit=1`
            );
            const amountRaw = String(storedIntent?.amount_raw ?? "");
            const expiresAt = Date.parse(storedIntent?.expires_at);
            if (!storedIntent ||
                storedIntent.player_id !== user.id ||
                storedIntent.network !== network ||
                storedIntent.mint_address !== config.official_mint_address ||
                storedIntent.token_program_id !== config.token_program_id ||
                storedIntent.treasury_address !== config.treasury_address ||
                storedIntent.token_decimals !== config.token_decimals ||
                !/^[1-9]\d*$/.test(amountRaw) ||
                amountRaw.length > 20 ||
                BigInt(amountRaw) > 18446744073709551615n ||
                !Number.isFinite(expiresAt) ||
                expiresAt <= Date.now() ||
                !["pending", "confirmed"].includes(storedIntent.status)) {
                return sendJson(response, 409, {
                    error: "payment_intent_invalid_or_expired",
                    message: "The payment intent is no longer valid. Start a new deposit before sending CYFUR."
                });
            }
            return sendJson(response, 200, {
                intentId: storedIntent.id,
                network: storedIntent.network,
                mintAddress: storedIntent.mint_address,
                tokenProgramId: storedIntent.token_program_id,
                treasuryAddress: storedIntent.treasury_address,
                amountRaw,
                tokenDecimals: storedIntent.token_decimals,
                treasuryTokenAccount,
                expiresAt: storedIntent.expires_at,
                memo: `RelicGrid payment intent: ${storedIntent.id}`
            });
        }

        if (request.body?.action !== undefined) {
            return sendJson(response, 400, { error: "invalid_action" });
        }

        const amountRaw = (10n ** BigInt(config.token_decimals)).toString();
        try {
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
            source_wallet_address: null,
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
            mintAddress: config.official_mint_address,
            tokenProgramId: config.token_program_id,
            treasuryAddress: config.treasury_address,
            treasuryTokenAccount,
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
        if (error.code === "23502") {
            return sendJson(response, 503, {
                error: "payment_intent_migration_required",
                message: "Apply supabase-walletless-deposits.sql in Supabase before creating deposits."
            });
        }
        if (error.status === 404 && error.code === "PGRST205") {
            return sendJson(response, 503, { error: "payment_intent_migration_required" });
        }
        return sendJson(response, 502, { error: "payment_intent_unavailable" });
    }
};
