const {
    authenticate,
    handleApiCors,
    hasWalletEnvironment,
    serviceRequest,
    sendJson
} = require("./wallet");
const {
    getSolanaNetwork,
    getSolanaRpcUrl,
    normalizeTransactionSignature,
    verifyFinalizedSuccessfulTransaction
} = require("./solana-deposit");

const CLAIM_POINTS = "1000";

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

        if (request.body?.action !== "claim") {
            return sendJson(response, 400, { error: "invalid_game_points_action" });
        }
        const signature = normalizeTransactionSignature(request.body?.signature);
        if (!signature) {
            return sendJson(response, 400, { error: "invalid_transaction_signature" });
        }

        const network = getSolanaNetwork();
        const verified = await verifyFinalizedSuccessfulTransaction({
            signature,
            network,
            rpcUrl: getSolanaRpcUrl()
        });
        if (verified.state === "not_found") {
            return sendJson(response, 404, { error: "transaction_not_found", claimed: false });
        }
        if (verified.state === "pending") {
            return sendJson(response, 202, { status: "pending", claimed: false });
        }
        if (verified.state === "failed") {
            return sendJson(response, 422, { error: "transaction_failed", claimed: false });
        }
        if (verified.state === "unsupported_network" || verified.state === "network_mismatch") {
            return sendJson(response, 503, { error: "solana_rpc_network_mismatch", claimed: false });
        }
        if (verified.state !== "finalized") {
            return sendJson(response, 503, { error: "transaction_verification_unavailable", claimed: false });
        }

        const result = await serviceRequest("rpc/claim_verified_game_points", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                p_player_id: user.id,
                p_transaction_signature: signature,
                p_network: network,
                p_finalized_slot: verified.slot
            })
        });
        const claim = Array.isArray(result) ? result[0] : result;
        if (!claim || !/^\d+$/.test(String(claim.balance_points))) {
            throw new Error("Verified game-points claim RPC returned an invalid balance.");
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
            claimedPoints: CLAIM_POINTS,
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
        return sendJson(response, 502, { error: "game_points_unavailable" });
    }
};
