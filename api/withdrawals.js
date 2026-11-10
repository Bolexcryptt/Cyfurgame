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
const { RELICGRID_CYFUR_MINT_ADDRESS, RELICGRID_TREASURY_ADDRESS, isBase58 } = require("../server/lib/solana-deposit");

function safeBigInt(value) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
    return BigInt(value);
}

function readWalletSystemConfig() {
    return serviceRequest(
        "wallet_system_config?select=network,official_mint_address,token_program_id,token_decimals,treasury_address,credits_per_token,deposits_enabled,withdrawals_enabled,withdrawal_rate_limit_per_hour&id=eq.1"
    ).then((rows) => rows[0] ?? null);
}

function sanitizeWithdrawalError(message) {
    return String(message || "")
        .replace(/https?:\/\/\S+/gi, "[redacted-url]")
        .replace(/[A-Za-z0-9+/_-]{80,}={0,2}/g, "[redacted-data]")
        .slice(0, 250);
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

        const [
            [linkedWallet],
            [account],
            [latestLedgerEntry],
            configs,
            history,
            completedLevels,
            gamePointCompletions
        ] = await Promise.all([
            serviceRequest(`player_solana_wallets?select=wallet_address,verified_at&player_id=eq.${encodeURIComponent(user.id)}&limit=1`),
            serviceRequest(`wallet_credit_accounts?select=balance_credits,updated_at&player_id=eq.${encodeURIComponent(user.id)}&limit=1`),
            serviceRequest(`wallet_credit_ledger?select=balance_after_credits&player_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc,id.desc&limit=1`),
            readWalletSystemConfig(),
            serviceRequest(`wallet_withdrawals?select=id,status,amount_credits,amount_raw,transaction_signature,created_at&player_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=20`),
            serviceRequest(`level_completions?select=level_number&player_id=eq.${encodeURIComponent(user.id)}&level_number=lte.30`),
            serviceRequest(`game_point_level_completions?select=level_number&player_id=eq.${encodeURIComponent(user.id)}&level_number=lte.30`)
        ]);

        const completedLevelNumbers = new Set([...completedLevels, ...gamePointCompletions]
            .map((completion) => Number(completion.level_number))
            .filter((levelNumber) => Number.isInteger(levelNumber) && levelNumber >= 1 && levelNumber <= 30));
        const level30Requirement = {
            requiredLevels: 30,
            completedLevels: completedLevelNumbers.size,
            remainingLevels: 30 - completedLevelNumbers.size,
            met: completedLevelNumbers.size === 30
        };
        const storedBalance = account?.balance_credits ?? latestLedgerEntry?.balance_after_credits ?? "0";
        const balanceCredits = String(storedBalance);
        const pendingCredits = history
            .filter((entry) => ["pending", "submitted"].includes(entry.status))
            .reduce((total, entry) => total + (safeBigInt(String(entry.amount_credits || "0")) ?? 0n), 0n);
        const availableCredits = balanceCredits;

        if (request.method === "GET") {
            const configurationReady = configs?.network === "mainnet-beta" &&
                configs.official_mint_address === RELICGRID_CYFUR_MINT_ADDRESS &&
                configs.treasury_address === RELICGRID_TREASURY_ADDRESS &&
                configs.token_program_id === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
                configs.token_decimals === 8 &&
                String(configs.credits_per_token) === "1000" &&
                configs.withdrawal_rate_limit_per_hour === 5 &&
                process.env.SOLANA_NETWORK === "mainnet-beta";
            let signerReady = false;
            if (configurationReady) {
                try {
                    signerReady = getWithdrawalSignerFromEnvironment()
                        .publicKey.toBase58() === RELICGRID_TREASURY_ADDRESS;
                } catch (error) {
                    console.error("Withdrawal signer readiness check failed.", {
                        code: error?.code || "withdrawal_signer_unavailable"
                    });
                }
            }
            const rpcConfigured = Boolean(process.env.SOLANA_RPC_URL?.trim());
            const featureEnabled = process.env.WITHDRAWAL_ENABLED === "true" &&
                configs?.withdrawals_enabled === true;
            return sendJson(response, 200, {
                withdrawalEnabled: featureEnabled && configurationReady && signerReady && rpcConfigured &&
                    level30Requirement.met,
                readiness: {
                    featureEnabled,
                    configurationReady,
                    signerReady,
                    rpcConfigured,
                    level30RequirementMet: level30Requirement.met
                },
                level30Requirement,
                walletAddress: linkedWallet?.wallet_address ?? null,
                walletVerified: Boolean(linkedWallet?.verified_at &&
                    isBase58(linkedWallet.wallet_address, 32)),
                balanceCredits,
                availableCredits,
                pendingWithdrawalCredits: pendingCredits.toString(),
                activeWithdrawal: history.some((entry) =>
                    ["pending", "submitted"].includes(entry.status)),
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
        if (!level30Requirement.met) {
            return sendJson(response, 403, {
                error: "level_30_required",
                level30Requirement,
                message: `Complete levels 1-30 to unlock withdrawals. ${level30Requirement.completedLevels} of 30 server-saved level clears are recorded.`
            });
        }
        if (!linkedWallet?.wallet_address || !isBase58(linkedWallet.wallet_address, 32) ||
            !linkedWallet.verified_at) {
            return sendJson(response, 400, { error: "wallet_not_verified" });
        }
        if (!configs || configs.official_mint_address !== RELICGRID_CYFUR_MINT_ADDRESS ||
            configs.treasury_address !== RELICGRID_TREASURY_ADDRESS ||
            configs.token_program_id !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
            configs.token_decimals !== 8 ||
            String(configs.credits_per_token) !== "1000" ||
            configs.withdrawal_rate_limit_per_hour !== 5 ||
            configs.network !== "mainnet-beta" ||
            process.env.SOLANA_NETWORK !== "mainnet-beta") {
            return sendJson(response, 503, {
                error: "withdrawal_not_configured",
                message: "The treasury and CYFUR mint configuration for withdrawals is not ready. The owner-approved configuration must be rechecked before any token transfer is attempted."
            });
        }
        if (process.env.WITHDRAWAL_ENABLED !== "true" || configs.withdrawals_enabled !== true) {
            return sendJson(response, 503, {
                error: "withdrawals_disabled",
                message: "Real CYFUR withdrawals require both the deployment withdrawal switch and the RelicGrid withdrawal setting."
            });
        }

        const amountCredits = request.body?.amountCredits;
        const requestedWalletAddress = request.body?.walletAddress;
        if (action === "submit" && (typeof requestedWalletAddress !== "string" ||
            !isBase58(requestedWalletAddress.trim(), 32) ||
            requestedWalletAddress.trim() !== linkedWallet.wallet_address)) {
            return sendJson(response, 400, {
                error: "withdrawal_wallet_mismatch",
                message: "The receiving wallet must exactly match the verified wallet linked to this game account."
            });
        }
        const amountCreditsString = typeof amountCredits === "string" ? amountCredits : String(amountCredits ?? "");
        if (!/^\d+$/.test(amountCreditsString)) {
            return sendJson(response, 400, { error: "invalid_amount_credits" });
        }
        const creditsBigInt = BigInt(amountCreditsString);
        if (creditsBigInt <= 0n) {
            return sendJson(response, 400, { error: "invalid_amount_credits" });
        }
        if (creditsBigInt > 9223372036854775807n) {
            return sendJson(response, 400, { error: "amount_out_of_range" });
        }
        if (creditsBigInt > BigInt(balanceCredits) || creditsBigInt > BigInt(availableCredits)) {
            return sendJson(response, 402, {
                error: "insufficient_balance",
                balanceCredits,
                availableCredits
            });
        }

        const amountRaw = calculateWithdrawalTokenAmountRaw(amountCreditsString, Number(configs.token_decimals));
        if (BigInt(amountRaw) > 9223372036854775807n) {
            return sendJson(response, 400, { error: "amount_out_of_range" });
        }
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

        const requestId = request.body?.idempotencyKey;
        if (typeof requestId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
            return sendJson(response, 400, { error: "idempotency_key_required" });
        }
        const signer = getWithdrawalSignerFromEnvironment();
        if (signer.publicKey.toBase58() !== configs.treasury_address) {
            return sendJson(response, 503, {
                error: "withdrawal_signer_mismatch",
                message: "The configured server-side signer does not match the authorized treasury address. No transfer was submitted."
            });
        }
        const idempotencyKey = `${user.id}:${requestId}`;
        const memo = `RelicGrid withdrawal:${randomUUID()}`;
        let reservation;
        try {
            const result = await serviceRequest("rpc/reserve_wallet_withdrawal", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    p_player_id: user.id,
                    p_wallet_address: linkedWallet.wallet_address,
                    p_network: configs.network,
                    p_mint_address: configs.official_mint_address,
                    p_token_program_id: configs.token_program_id,
                    p_treasury_address: configs.treasury_address,
                    p_amount_raw: amountRaw,
                    p_token_decimals: Number(configs.token_decimals),
                    p_amount_credits: amountCreditsString,
                    p_idempotency_key: idempotencyKey,
                    p_memo: memo
                })
            });
            reservation = Array.isArray(result) ? result[0] : result;
        } catch (error) {
            const details = String(error.databaseMessage || error.details || "");
            if (/insufficient credits/i.test(details)) {
                return sendJson(response, 402, { error: "insufficient_balance", availableCredits });
            }
            if (/withdrawal request rate limit exceeded/i.test(details)) {
                return sendJson(response, 429, { error: "withdrawal_rate_limited" });
            }
            if (/already pending reconciliation|idempotency key was reused/i.test(details)) {
                return sendJson(response, 409, { error: "withdrawal_already_pending" });
            }
            throw error;
        }

        if (!reservation?.withdrawal_id) {
            throw new Error("The withdrawal reservation RPC returned no withdrawal record.");
        }
        if (reservation.already_reserved) {
            const payload = {
                status: reservation.withdrawal_status,
                amountCredits: amountCreditsString,
                amountRaw,
                signature: reservation.transaction_signature,
                walletAddress: linkedWallet.wallet_address,
                message: "This withdrawal request was already recorded. Its transfer will not be submitted a second time."
            };
            if (reservation.withdrawal_status === "confirmed") {
                return sendJson(response, 200, payload);
            }
            if (reservation.withdrawal_status === "pending" || reservation.withdrawal_status === "submitted") {
                return sendJson(response, 202, payload);
            }
            return sendJson(response, 409, { ...payload, error: "withdrawal_request_already_resolved" });
        }

        let submittedSignature = null;
        try {
            const execution = await executeCyfurWithdrawal({
                rpcUrl: process.env.SOLANA_RPC_URL,
                playerWalletAddress: linkedWallet.wallet_address,
                treasuryAddress: configs.treasury_address,
                mintAddress: configs.official_mint_address,
                tokenProgramId: configs.token_program_id,
                tokenDecimals: Number(configs.token_decimals),
                amountRaw,
                treasurySigner: signer,
                onSubmitted: async (signature) => {
                    submittedSignature = signature;
                    await serviceRequest("rpc/mark_wallet_withdrawal_submitted", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            p_withdrawal_id: reservation.withdrawal_id,
                            p_transaction_signature: signature
                        })
                    });
                }
            });

            const finalized = await serviceRequest("rpc/confirm_wallet_withdrawal", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    p_withdrawal_id: reservation.withdrawal_id,
                    p_transaction_signature: execution.signature
                })
            });
            const finalResult = Array.isArray(finalized) ? finalized[0] : finalized;
            if (!finalResult) {
                return sendJson(response, 202, {
                    status: "submitted",
                    amountCredits: amountCreditsString,
                    amountRaw,
                    signature: execution.signature,
                    walletAddress: linkedWallet.wallet_address,
                    message: "The transfer finalized on Solana; database confirmation is pending reconciliation."
                });
            }

            return sendJson(response, 200, {
                status: "confirmed",
                amountCredits: amountCreditsString,
                amountRaw,
                signature: execution.signature,
                walletAddress: linkedWallet.wallet_address,
                balanceCredits: String(finalResult.balance_credits)
            });
        } catch (error) {
            const signature = submittedSignature || error.signature || null;
            if (!signature || error.chainFailed === true) {
                const safeFailureReason = sanitizeWithdrawalError(error?.message) ||
                    "Withdrawal transfer failed.";
                try {
                    await serviceRequest("rpc/release_wallet_withdrawal", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            p_withdrawal_id: reservation.withdrawal_id,
                            p_failure_reason: safeFailureReason,
                            p_chain_failure_verified: error.chainFailed === true,
                            p_transaction_signature: signature
                        })
                    });
                } catch (releaseError) {
                    console.error("Withdrawal reservation could not be released.", {
                        code: releaseError.code || "withdrawal_release_failed"
                    });
                    return sendJson(response, 503, {
                        error: "withdrawal_reconciliation_required",
                        message: "The withdrawal was not confirmed. Its balance reservation remains in place until safely reconciled."
                    });
                }
                return sendJson(response, 502, {
                    error: "withdrawal_failed",
                    message: safeFailureReason,
                    walletAddress: linkedWallet.wallet_address,
                    status: "failed"
                });
            }

            return sendJson(response, 202, {
                status: "submitted",
                amountCredits: amountCreditsString,
                amountRaw,
                signature,
                walletAddress: linkedWallet.wallet_address,
                message: "The transaction may have been submitted. The balance remains reserved while its finalized status is reconciled; do not retry with a new request."
            });
        }
    } catch (error) {
        console.error("Withdrawal request failed.", {
            code: error?.code || "withdrawal_failed",
            message: sanitizeWithdrawalError(error?.message)
        });
        if (error?.status === 404) {
            return sendJson(response, 503, { error: "wallet_schema_not_installed" });
        }
        return sendJson(response, 500, {
            error: "withdrawal_unavailable",
            message: "Withdrawal processing is unavailable. Please try again later."
        });
    }
};
