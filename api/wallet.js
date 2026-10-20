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
        const verifierConfigured = Boolean(
            config?.official_mint_address &&
            config.token_program_id &&
            Number.isInteger(config.token_decimals) &&
            String(config.credits_per_token) === String(CYFUR_CREDITS_PER_TOKEN) &&
            config.rounding_policy === "floor" &&
            config.network === network &&
            process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() &&
            process.env.SOLANA_RPC_URL?.trim() &&
            process.env.SOLANA_TREASURY_ADDRESS?.trim() === treasuryAddress &&
            process.env.WALLET_DIRECT_TREASURY_READY === "true"
        );
        const depositsEnabled =
            Boolean(linkedWalletAddress) &&
            Boolean(treasuryAddress) &&
            verifierConfigured &&
            config?.deposits_enabled === true &&
            process.env.WALLET_DEPOSITS_ENABLED === "true" &&
            (network !== "mainnet-beta" ||
                process.env.WALLET_MAINNET_DEPOSITS_ENABLED === "true");
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
            disabledMessage: depositsEnabled
                ? "Deposit verification is ready. Send CYFUR from your linked Solana wallet to the owner-controlled treasury, then submit the transaction signature."
                : !linkedWalletAddress
                    ? "Connect and verify your Solana wallet first. Deposits remain disabled until the direct treasury verifier is configured. Do not send CYFUR."
                    : "Funding is disabled until the owner-controlled treasury, finalized verifier, database migration, and server activation checks are complete. Do not send CYFUR.",
            exchangeRateCreditsPerToken: CYFUR_CREDITS_PER_TOKEN,
            treasuryAddress,
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
