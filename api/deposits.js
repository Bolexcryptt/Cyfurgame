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
    normalizeTransactionSignature,
    isBase58,
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS,
    TOKEN_PROGRAM_IDS,
    verifyFinalizedDeposit
} = require("../server/lib/solana-deposit");

function respondNotReady(response, error, message) {
    return sendJson(response, 503, {
        error,
        fundingStatus: "disabled",
        message
    });
}

module.exports = async function deposits(request, response) {
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

        const missing = [
            "SUPABASE_SERVICE_ROLE_KEY",
            "SOLANA_RPC_URL"
        ].filter((name) => !process.env[name]?.trim());
        if (missing.length) {
            return respondNotReady(
                response,
                "wallet_verifier_not_configured",
                `Deposit verification is disabled. Configure server-only ${missing.join(", ")}. Do not send CYFUR.`
            );
        }
        if (process.env.WALLET_DIRECT_TREASURY_READY !== "true") {
            return respondNotReady(
                response,
                "direct_treasury_not_ready",
                "Direct-to-treasury deposits are disabled until the owner-controlled treasury and reconciliation process are reviewed and approved. Do not send CYFUR."
            );
        }
        const configuredNetwork = process.env.SOLANA_NETWORK;
        if (process.env.WALLET_DEPOSITS_ENABLED !== "true" ||
            !["devnet", "mainnet-beta"].includes(configuredNetwork)) {
            return respondNotReady(
                response,
                "deposits_disabled",
                "Deposit verification is disabled. Set an explicit Solana network and keep the deposit flag off until the owner-controlled treasury and verifier are approved and tested. Do not send CYFUR."
            );
        }
        if (configuredNetwork === "mainnet-beta" &&
            process.env.WALLET_MAINNET_DEPOSITS_ENABLED !== "true") {
            return respondNotReady(
                response,
                "mainnet_deposits_disabled",
                "Mainnet deposits have not been explicitly enabled after production review. Do not send CYFUR."
            );
        }

        const signature = normalizeTransactionSignature(request.body?.signature);
        if (!signature) {
            return sendJson(response, 400, { error: "invalid_transaction_signature" });
        }

        const transactionUrl =
            `https://explorer.solana.com/tx/${signature}?cluster=${encodeURIComponent(configuredNetwork)}`;
        const [configs] = await Promise.all([
            serviceRequest("wallet_system_config?select=deposits_enabled,network,official_mint_address,token_program_id,token_decimals,credits_per_token,rounding_policy,treasury_address&id=eq.1")
        ]);
        const config = configs[0];
        if (!config || config.deposits_enabled !== true || config.network !== configuredNetwork ||
            !config.official_mint_address || !config.token_program_id ||
            !isBase58(config.official_mint_address, 32) ||
            config.official_mint_address !== RELICGRID_CYFUR_MINT_ADDRESS ||
            !isBase58(config.treasury_address, 32) ||
            !TOKEN_PROGRAM_IDS.has(config.token_program_id) ||
            !Number.isInteger(config.token_decimals) ||
            String(config.credits_per_token) !== "10000" || config.rounding_policy !== "floor" ||
            config.treasury_address !== RELICGRID_TREASURY_ADDRESS ||
            !config.treasury_address) {
            return respondNotReady(
                response,
                "wallet_configuration_incomplete",
                "Deposit verification is disabled: the approved network, mint, token metadata, treasury address, floor-rounding policy, and enabled database configuration must match. Do not send CYFUR."
            );
        }
        const minimumAmountRaw = (10n ** BigInt(config.token_decimals)).toString();
        const treasuryTokenAccount = deriveAssociatedTokenAccount(
            config.treasury_address,
            config.official_mint_address,
            config.token_program_id
        );
        const verified = await verifyFinalizedDeposit({
            signature,
            depositAddress: config.treasury_address,
            depositTokenAccount: treasuryTokenAccount,
            officialMint: config.official_mint_address,
            tokenProgramId: config.token_program_id,
            tokenDecimals: config.token_decimals,
            network: config.network,
            rpcUrl: process.env.SOLANA_RPC_URL,
            minimumAmountRaw,
            requirePaymentIntentMemo: true
        });
        if (verified.state === "pending") {
            return sendJson(response, 202, { status: "pending", credited: false, transactionUrl });
        }
        if (verified.state === "not_found") {
            return sendJson(response, 404, { error: "transaction_not_found", credited: false, transactionUrl });
        }
        if (verified.state === "failed") {
            return sendJson(response, 422, { error: "transaction_failed", credited: false, transactionUrl });
        }
        if (verified.state === "wrong_destination_or_token") {
            return sendJson(response, 422, { error: "wrong_token_or_destination", credited: false, transactionUrl });
        }
        if (verified.state === "wrong_amount") {
            return sendJson(response, 422, { error: "wrong_amount", credited: false, transactionUrl });
        }
        if (verified.state === "payment_intent_mismatch") {
            return sendJson(response, 422, {
                error: "payment_intent_mismatch",
                credited: false,
                transactionUrl
            });
        }
        if (verified.state === "invalid_treasury") {
            return respondNotReady(
                response,
                "invalid_treasury_address",
                "The configured treasury address is not an ordinary System Program-owned wallet. Do not send CYFUR; correct the treasury configuration first."
            );
        }
        if (verified.state === "invalid_treasury_token_account") {
            return respondNotReady(
                response,
                "invalid_treasury_token_account",
                "The expected CYFUR associated token account is missing or does not match the configured treasury and mint."
            );
        }
        if (verified.state !== "finalized") {
            return sendJson(response, 503, { error: "finalized_transaction_unavailable", credited: false });
        }
        const paymentIntentId = verified.paymentIntentId;
        if (!paymentIntentId) {
            return sendJson(response, 422, {
                error: "payment_intent_mismatch",
                credited: false,
                transactionUrl
            });
        }
        const [intent] = await serviceRequest(
            `wallet_payment_intents?select=id,player_id,network,mint_address,token_program_id,treasury_address,amount_raw,token_decimals,created_at,expires_at,status,transaction_signature&id=eq.${encodeURIComponent(paymentIntentId)}&player_id=eq.${encodeURIComponent(user.id)}&limit=1`
        );
        if (!intent ||
            intent.id !== paymentIntentId ||
            intent.player_id !== user.id ||
            intent.network !== config.network ||
            intent.mint_address !== config.official_mint_address ||
            intent.token_program_id !== config.token_program_id ||
            intent.treasury_address !== config.treasury_address ||
            intent.token_decimals !== config.token_decimals ||
            String(intent.amount_raw) !== minimumAmountRaw ||
            !["pending", "confirmed"].includes(intent.status) ||
            (intent.status === "confirmed" && intent.transaction_signature !== signature)) {
            return sendJson(response, 409, {
                error: "payment_intent_invalid_or_claimed",
                credited: false,
                transactionUrl
            });
        }
        if (!Number.isSafeInteger(verified.finalizedAt) || !intent.created_at || !intent.expires_at) {
            return sendJson(response, 422, { error: "payment_intent_time_unverifiable", credited: false, transactionUrl });
        }
        let creditAmount;
        try {
            creditAmount = getDepositCreditAmount(
                verified.amountRaw,
                config.token_decimals,
                config.rounding_policy
            );
        } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) {
                return sendJson(response, 422, { error: "deposit_amount_not_creditable", credited: false });
            }
            throw error;
        }
        const [ledgerResult] = await serviceRequest("rpc/process_verified_payment_intent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                p_payment_intent_id: intent.id,
                p_player_id: user.id,
                p_source_wallet_address: verified.sourceWalletAddress,
                p_network: config.network,
                p_transaction_signature: signature,
                p_mint_address: config.official_mint_address,
                p_token_program_id: config.token_program_id,
                p_deposit_address: config.treasury_address,
                p_amount_raw: verified.amountRaw,
                p_token_decimals: config.token_decimals,
                p_finalized_slot: verified.finalizedSlot,
                p_finalized_at: new Date(verified.finalizedAt * 1000).toISOString(),
                p_credit_amount_credits: creditAmount
            })
        });
        if (!ledgerResult || !/^\d+$/.test(String(ledgerResult.balance_credits))) {
            throw new Error("Wallet ledger RPC returned an invalid result.");
        }
        return sendJson(response, 200, {
            status: "confirmed",
            credited: !ledgerResult.already_applied,
            alreadyProcessed: ledgerResult.already_applied === true,
            amountRaw: verified.amountRaw,
            tokenDecimals: config.token_decimals,
            creditAmountCredits: creditAmount,
            balanceCredits: String(ledgerResult.balance_credits),
            transactionUrl
        });
    } catch (error) {
        console.error("Deposit verification failed closed.", {
            status: error.status ?? 500,
            code: error.code ?? "deposit_verification_failed",
            message: error.message
        });
        if (error.status === 404 && error.code === "PGRST202") {
            return sendJson(response, 503, { error: "wallet_migration_required" });
        }
        if (error.status === 404 && error.code === "PGRST205") {
            return sendJson(response, 503, { error: "wallet_schema_not_installed" });
        }
        if (["22023", "23505"].includes(error.code)) {
            return sendJson(response, 422, {
                error: "transaction_already_claimed",
                credited: false
            });
        }
        return sendJson(response, 502, { error: "deposit_verification_unavailable", credited: false });
    }
};
