const {
    authenticate,
    handleApiCors,
    hasWalletEnvironment,
    serviceRequest,
    sendJson
} = require("./wallet");
const {
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS,
    deriveAssociatedTokenAccount,
    getSolanaNetwork,
    getSolanaRpcUrl,
    normalizeTransactionSignature,
    TOKEN_PROGRAM_IDS,
    verifyFinalizedDeposit
} = require("./solana-deposit");
const { getDepositCreditAmount } = require("./wallet");

const CYFUR_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function readPointBalance(playerId) {
    return serviceRequest(
        `game_point_accounts?select=balance_points&player_id=eq.${encodeURIComponent(playerId)}&limit=1`
    ).then((accounts) => {
        const balance = accounts[0]?.balance_points ?? "0";
        if (!/^\d+$/.test(String(balance))) {
            throw new Error("Game-points account returned an invalid balance.");
        }
        return String(balance);
    });
}

function readServerCompletions(playerId) {
    return serviceRequest(
        `game_point_level_completions?select=level_number&player_id=eq.${encodeURIComponent(playerId)}&order=level_number.asc`
    ).then((rows) => rows
        .map((row) => Number(row.level_number))
        .filter((levelNumber) => Number.isInteger(levelNumber) && levelNumber >= 1 && levelNumber <= 99));
}

module.exports = async function gamePoints(request, response) {
    if (handleApiCors(request, response)) return;
    if (request.method !== "GET" && request.method !== "POST") {
        response.setHeader("Allow", "GET, POST");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (!hasWalletEnvironment() || !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
        return sendJson(response, 503, { error: "game_points_api_not_configured" });
    }

    try {
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });

        if (request.method === "GET") {
            const [balancePoints, completedLevels] = await Promise.all([
                readPointBalance(user.id),
                readServerCompletions(user.id)
            ]);
            return sendJson(response, 200, { balancePoints, completedLevels });
        }

        if (request.body?.action !== "verify-deposit") {
            return sendJson(response, 400, { error: "invalid_game_points_action" });
        }
        const signature = normalizeTransactionSignature(request.body?.signature);
        if (!signature) {
            return sendJson(response, 400, { error: "invalid_transaction_signature" });
        }

        const network = getSolanaNetwork();
        const [configs] = await Promise.all([
            serviceRequest("wallet_system_config?select=network,official_mint_address,token_program_id,token_decimals,credits_per_token,rounding_policy,treasury_address&id=eq.1")
        ]);
        const config = configs[0];
        if (!config ||
            config.network !== network ||
            config.official_mint_address !== RELICGRID_CYFUR_MINT_ADDRESS ||
            config.token_program_id !== CYFUR_TOKEN_PROGRAM_ID ||
            !TOKEN_PROGRAM_IDS.has(config.token_program_id) ||
            config.token_decimals !== 8 ||
            String(config.credits_per_token) !== "1000" ||
            config.rounding_policy !== "floor" ||
            config.treasury_address !== RELICGRID_TREASURY_ADDRESS) {
            return sendJson(response, 503, { error: "game_points_deposit_not_configured" });
        }

        const depositTokenAccount = deriveAssociatedTokenAccount(
            config.treasury_address,
            config.official_mint_address,
            config.token_program_id
        );
        let verified;
        try {
            verified = await verifyFinalizedDeposit({
                signature,
                depositAddress: config.treasury_address,
                depositTokenAccount,
                officialMint: config.official_mint_address,
                tokenProgramId: config.token_program_id,
                tokenDecimals: config.token_decimals,
                network,
                rpcUrl: getSolanaRpcUrl()
            });
        } catch (error) {
            if (error.message === "Configured Solana RPC endpoint is connected to a different network.") {
                return sendJson(response, 503, { error: "solana_rpc_network_mismatch", claimed: false });
            }
            throw error;
        }
        if (verified.state === "not_found") {
            return sendJson(response, 404, { error: "transaction_not_found", claimed: false });
        }
        if (verified.state === "pending") {
            return sendJson(response, 202, { status: "pending", claimed: false });
        }
        if (verified.state === "failed") {
            return sendJson(response, 422, { error: "transaction_failed", claimed: false });
        }
        if (verified.state === "wrong_destination_or_token") {
            return sendJson(response, 422, { error: "cyfur_transfer_not_found", claimed: false });
        }
        if (verified.state !== "finalized") {
            return sendJson(response, 503, { error: "transaction_verification_unavailable", claimed: false });
        }
        let claimedPoints;
        try {
            claimedPoints = getDepositCreditAmount(verified.amountRaw, config.token_decimals, "floor");
        } catch (error) {
            if (error instanceof RangeError) {
                return sendJson(response, 422, { error: "cyfur_amount_too_small", claimed: false });
            }
            throw error;
        }

        const result = await serviceRequest("rpc/credit_verified_cyfur_game_points", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                p_player_id: user.id,
                p_transaction_signature: signature,
                p_network: network,
                p_finalized_slot: verified.finalizedSlot,
                p_amount_raw: verified.amountRaw,
                p_token_decimals: config.token_decimals,
                p_mint_address: config.official_mint_address,
                p_token_program_id: config.token_program_id,
                p_treasury_address: config.treasury_address
            })
        });
        const claim = Array.isArray(result) ? result[0] : result;
        if (!claim || !/^\d+$/.test(String(claim.balance_points)) ||
            !/^\d+$/.test(String(claim.amount_points)) ||
            String(claim.amount_points) !== claimedPoints) {
            throw new Error("Verified CYFUR game-points RPC returned an inconsistent amount or balance.");
        }
        if (claim.already_claimed === true) {
            return sendJson(response, 409, {
                error: "transaction_already_claimed",
                claimed: false,
                balancePoints: String(claim.balance_points)
            });
        }
        return sendJson(response, 200, {
            status: "confirmed",
            claimed: true,
            amountRaw: verified.amountRaw,
            tokenDecimals: config.token_decimals,
            claimedPoints: String(claim.amount_points),
            balancePoints: String(claim.balance_points),
            transactionSignature: signature
        });
    } catch (error) {
        console.error("Server game-points request failed closed.", {
            status: error.status ?? 500,
            code: error.code ?? "game_points_request_failed"
        });
        if (error.status === 404 && error.code === "PGRST202") {
            return sendJson(response, 503, { error: "game_points_migration_required" });
        }
        if (error.status === 404 && error.code === "PGRST205") {
            return sendJson(response, 503, { error: "game_points_schema_not_installed" });
        }
        if (error.code === "23505") {
            return sendJson(response, 409, { error: "transaction_already_credited" });
        }
        if (error.code === "22023") {
            return sendJson(response, 503, { error: "game_points_deposit_not_configured" });
        }
        return sendJson(response, 502, { error: "game_points_unavailable" });
    }
};
