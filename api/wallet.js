const {
    CYFUR_CREDITS_PER_TOKEN,
    authenticate,
    hasWalletEnvironment,
    selectOwn,
    serviceRequest,
    sendJson
} = require("./_lib/wallet");

module.exports = async function wallet(request, response) {
    if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (!hasWalletEnvironment()) {
        return sendJson(response, 503, { error: "wallet_api_not_configured" });
    }

    try {
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });

        const [linkedWallets, accounts, deposits] = await Promise.all([
            selectOwn(request, "player_solana_wallets", new URLSearchParams({
                select: "wallet_address,verified_at",
                limit: "1"
            })),
            selectOwn(request, "wallet_credit_accounts", new URLSearchParams({
                select: "balance_credits,updated_at",
                limit: "1"
            })),
            selectOwn(request, "wallet_deposits", new URLSearchParams({
                select: "id,network,transaction_signature,amount_raw,token_decimals,status,credit_amount_credits,created_at,confirmed_at,failure_reason",
                order: "created_at.desc",
                limit: "20"
            }))
        ]);
        let config = null;
        if (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
            const configs = await serviceRequest(
                "wallet_system_config?select=deposits_enabled,paid_gameplay_enabled,network,official_mint_address,token_program_id,token_decimals,credits_per_token,rounding_policy,treasury_address&id=eq.1"
            );
            config = configs[0] ?? null;
        }
        const network = process.env.SOLANA_NETWORK;
        const linkedWalletAddress = linkedWallets[0]?.wallet_address ?? null;
        const treasuryAddress = config?.treasury_address ?? null;
        const readinessChecks = [];
        if (!linkedWalletAddress) readinessChecks.push("Connect and verify your Solana wallet.");
        if (!config ||
            !config.official_mint_address ||
            !config.token_program_id ||
            !Number.isInteger(config.token_decimals) ||
            String(config.credits_per_token) !== String(CYFUR_CREDITS_PER_TOKEN) ||
            config.rounding_policy !== "floor" ||
            config.network !== network ||
            !treasuryAddress) {
            readinessChecks.push("Supabase wallet configuration must match the selected Solana network and CYFUR settings.");
        }
        if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
            readinessChecks.push("Set SUPABASE_SERVICE_ROLE_KEY in Vercel.");
        }
        if (!process.env.SOLANA_RPC_URL?.trim()) {
            readinessChecks.push("Set SOLANA_RPC_URL in Vercel.");
        }
        if (!process.env.SOLANA_TREASURY_ADDRESS?.trim() ||
            process.env.SOLANA_TREASURY_ADDRESS !== treasuryAddress) {
            readinessChecks.push("SOLANA_TREASURY_ADDRESS must exactly match Supabase treasury_address.");
        }
        if (process.env.WALLET_DIRECT_TREASURY_READY !== "true") {
            readinessChecks.push("Set WALLET_DIRECT_TREASURY_READY=true in Vercel.");
        }
        if (config?.deposits_enabled !== true) {
            readinessChecks.push("Set wallet_system_config.deposits_enabled=true in Supabase after approval.");
        }
        if (process.env.WALLET_DEPOSITS_ENABLED !== "true") {
            readinessChecks.push("Set WALLET_DEPOSITS_ENABLED=true in Vercel after approval.");
        }
        if (network === "mainnet-beta" &&
            process.env.WALLET_MAINNET_DEPOSITS_ENABLED !== "true") {
            readinessChecks.push("Set WALLET_MAINNET_DEPOSITS_ENABLED=true in Vercel after mainnet approval.");
        }
        const depositsEnabled = readinessChecks.length === 0;
        const balance = accounts[0]?.balance_credits;
        const balanceVerified = (typeof balance === "string" && /^\d+$/.test(balance)) ||
            (typeof balance === "number" && Number.isSafeInteger(balance) && balance >= 0);
        const paidGameplayEnabled =
            config?.paid_gameplay_enabled === true &&
            process.env.WALLET_PAID_GAMEPLAY_ENABLED === "true" &&
            Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());

        return sendJson(response, 200, {
            depositsEnabled,
            paidGameplayEnabled,
            fundingStatus: depositsEnabled ? "ready" : "disabled",
            network: network ?? null,
            disabledReason: depositsEnabled ? null : "direct_treasury_setup_incomplete",
            readinessChecks,
            disabledMessage: depositsEnabled
                ? "Deposit verification is ready. Approve a CYFUR transfer from your linked Solana wallet; FluxGrid will verify the finalized transaction before crediting."
                : `${readinessChecks.join(" ")} Do not send CYFUR until status is READY.`,
            exchangeRateCreditsPerToken: CYFUR_CREDITS_PER_TOKEN,
            treasuryAddress,
            officialMintAddress: config?.official_mint_address ?? null,
            tokenProgramId: config?.token_program_id ?? null,
            tokenDecimals: Number.isInteger(config?.token_decimals) ? config.token_decimals : null,
            linkedWalletAddress,
            balanceCredits: balanceVerified ? String(balance) : null,
            balanceVerified,
            deposits
        });
    } catch (error) {
        console.error("Wallet data request failed.", {
            status: error.status ?? 500,
            code: error.code ?? "wallet_request_failed"
        });
        if (error.status === 404 && error.code === "PGRST205") {
            return sendJson(response, 503, { error: "wallet_schema_not_installed" });
        }
        return sendJson(response, 502, { error: "wallet_data_unavailable" });
    }
};
