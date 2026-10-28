const { randomUUID } = require("node:crypto");
const {
    authenticate,
    handleApiCors,
    hasWalletEnvironment,
    sendJson,
    serviceRequest
} = require("../server/lib/wallet");
const {
    calculateWithdrawalTokenAmountRaw,
    executeCyfurWithdrawal,
    getWithdrawalSignerFromEnvironment
} = require("../server/lib/withdrawals");
const { RELICGRID_CYFUR_MINT_ADDRESS, RELICGRID_TREASURY_ADDRESS, isBase58, TOKEN_PROGRAM_IDS } = require("../server/lib/solana-deposit");

function safeBigInt(value) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
    return BigInt(value);
}

function readWalletSystemConfig() {
    return serviceRequest(
        "wallet_system_config?select=network,official_mint_address,token_program_id,token_decimals,treasury_address,credits_per_token,deposits_enabled&id=eq.1"
    ).then((rows) => rows[0] ?? null);
}

module.exports = async function withdrawals(request, response) {
    if (handleApiCors(request, response)) return;
    if (request.method !== "GET" && request.method !== "POST") {
        response.setHeader("Allow", "GET, POST");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (!hasWalletEnvironment()) {
        return sendJson(response, 503, { error: "wallet_api_not_configured" });
    }

    try {
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });

        const [[linkedWallet], [account], configs, history] = await Promise.all([
            serviceRequest(`player_solana_wallets?select=wallet_address,verified_at&player_id=eq.${encodeURIComponent(user.id)}&limit=1`),
            serviceRequest(`wallet_credit_accounts?select=balance_credits,updated_at&player_id=eq.${encodeURIComponent(user.id)}&limit=1`),
            readWalletSystemConfig(),
            serviceRequest(`wallet_withdrawals?select=id,status,amount_credits,amount_raw,transaction_signature,created_at&player_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=20`)
        ]);

        const balanceCredits = account?.balance_credits ? String(account.balance_credits) : "0";
        const pendingCredits = history
            .filter((entry) => ["pending", "submitted"].includes(entry.status))
            .reduce((total, entry) => total + safeBigInt(entry.amount_credits || "0") || 0n, 0n);
        const availableCredits = (BigInt(balanceCredits) - pendingCredits).toString();

        if (request.method === "GET") {
            return sendJson(response, 200, {
                withdrawalEnabled: process.env.WITHDRAWAL_ENABLED === "true",
                walletAddress: linkedWallet?.wallet_address ?? null,
                balanceCredits,
                availableCredits,
                config: configs ? {
                    network: configs.network,
                    officialMintAddress: configs.official_mint_address,
                    tokenProgramId: configs.token_program_id,
                    tokenDecimals: configs.token_decimals,
                    treasuryAddress: configs.treasury_address,
                    creditsPerToken: configs.credits_per_token
                } : null,
                withdrawals: history ?? []
            });
        }

        const action = request.body?.action || "preview";
        if (action !== "preview" && action !== "submit") {
            return sendJson(response, 400, { error: "invalid_withdrawal_action" });
        }
        if (!linkedWallet?.wallet_address || !isBase58(linkedWallet.wallet_address, 32)) {
            return sendJson(response, 400, { error: "wallet_not_linked" });
        }
        if (!configs || configs.official_mint_address !== RELICGRID_CYFUR_MINT_ADDRESS ||
            configs.treasury_address !== RELICGRID_TREASURY_ADDRESS ||
            !TOKEN_PROGRAM_IDS.has(configs.token_program_id) ||
            !Number.isInteger(configs.token_decimals) ||
            configs.token_decimals < 0 || configs.token_decimals > 18 ||
            String(configs.credits_per_token) !== "10000" ||
            configs.network !== process.env.SOLANA_NETWORK ||
            !["devnet", "mainnet-beta"].includes(configs.network)) {
            return sendJson(response, 503, {
                error: "withdrawal_not_configured",
                message: "The treasury and CYFUR mint configuration for withdrawals is not ready. The owner-approved configuration must be rechecked before any token transfer is attempted."
            });
        }
        if (process.env.WITHDRAWAL_ENABLED !== "true") {
            return sendJson(response, 503, {
                error: "withdrawals_disabled",
                message: "Real CYFUR withdrawals are disabled until the server-side treasury signer and owner approval are configured."
            });
        }

        const amountCredits = request.body?.amountCredits;
        const amountCreditsString = typeof amountCredits === "string" ? amountCredits : String(amountCredits ?? "");
        if (!/^\d+$/.test(amountCreditsString)) {
            return sendJson(response, 400, { error: "invalid_amount_credits" });
        }
        const creditsBigInt = BigInt(amountCreditsString);
        if (creditsBigInt <= 0n) {
            return sendJson(response, 400, { error: "invalid_amount_credits" });
        }
        if (creditsBigInt > BigInt(balanceCredits) || creditsBigInt > BigInt(availableCredits)) {
            return sendJson(response, 402, {
                error: "insufficient_balance",
                balanceCredits,
                availableCredits
            });
        }

        const amountRaw = calculateWithdrawalTokenAmountRaw(amountCreditsString, Number(configs.token_decimals));
        if (action === "preview") {
            return sendJson(response, 200, {
                amountCredits: amountCreditsString,
                amountRaw,
                walletAddress: linkedWallet.wallet_address,
                availableCredits,
                network: configs.network,
                treasuryAddress: configs.treasury_address,
                mintAddress: configs.official_mint_address,
                tokenDecimals: configs.token_decimals,
                tokenProgramId: configs.token_program_id,
                ready: true
            });
        }

        const idempotencyKey = `${user.id}:${linkedWallet.wallet_address}:${amountCreditsString}:${Date.now()}`;
        const signer = getWithdrawalSignerFromEnvironment();
        if (signer.publicKey.toBase58() !== configs.treasury_address) {
            return sendJson(response, 503, {
                error: "withdrawal_signer_mismatch",
                message: "The configured server-side signer does not match the authorized treasury address. No transfer was submitted."
            });
        }
        const pendingRecord = {
            player_id: user.id,
            wallet_address: linkedWallet.wallet_address,
            amount_credits: Number(amountCreditsString),
            amount_raw: Number(amountRaw),
            token_decimals: Number(configs.token_decimals),
            status: "pending",
            idempotency_key: idempotencyKey,
            memo: `RelicGrid withdrawal:${randomUUID()}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const insertResult = await serviceRequest("wallet_withdrawals?select=id,status,idempotency_key&on_conflict=idempotency_key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(pendingRecord)
        });
        const withdrawalRecord = Array.isArray(insertResult) ? insertResult[0] : insertResult;

        try {
            const execution = await executeCyfurWithdrawal({
                rpcUrl: process.env.SOLANA_RPC_URL,
                playerWalletAddress: linkedWallet.wallet_address,
                treasuryAddress: configs.treasury_address,
                mintAddress: configs.official_mint_address,
                tokenProgramId: configs.token_program_id,
                tokenDecimals: Number(configs.token_decimals),
                amountRaw,
                treasurySigner: signer
            });

            await serviceRequest(`wallet_withdrawals?id=eq.${encodeURIComponent(withdrawalRecord.id)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    status: "confirmed",
                    transaction_signature: execution.signature,
                    confirmed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
            });
            await serviceRequest("rpc/apply_wallet_ledger_entry", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    p_player_id: user.id,
                    p_entry_type: "withdrawal",
                    p_amount_credits: -BigInt(amountCreditsString),
                    p_idempotency_key: `withdrawal:${withdrawalRecord.id}`,
                    p_memo: `Withdrawal:${withdrawalRecord.id}`
                })
            });

            return sendJson(response, 200, {
                status: "confirmed",
                amountCredits: amountCreditsString,
                amountRaw,
                signature: execution.signature,
                walletAddress: linkedWallet.wallet_address
            });
        } catch (error) {
            await serviceRequest(`wallet_withdrawals?id=eq.${encodeURIComponent(withdrawalRecord.id)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    status: "failed",
                    failure_reason: error?.message || "Withdrawal transfer failed.",
                    updated_at: new Date().toISOString()
                })
            });
            return sendJson(response, 502, {
                error: "withdrawal_failed",
                message: error?.message || "The server-side withdrawal attempt failed.",
                walletAddress: linkedWallet.wallet_address,
                status: "failed"
            });
        }
    } catch (error) {
        console.error("Withdrawal request failed.", error);
        if (error?.status === 404) {
            return sendJson(response, 503, { error: "wallet_schema_not_installed" });
        }
        return sendJson(response, 500, { error: "withdrawal_unavailable", message: error?.message || "Withdrawal processing is unavailable." });
    }
};
