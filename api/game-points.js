const {
    authenticate,
    getLevelEntryCostCredits,
    handleApiCors,
    hasServiceDatabaseEnvironment,
    serviceRequest,
    sendJson
} = require("../server/lib/wallet");
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const signaturePattern = /^[1-9A-HJ-NP-Za-km-z]{80,100}$/;

async function getBalance(playerId) {
    const accounts = await serviceRequest(
        `game_point_accounts?select=balance_points&player_id=eq.${encodeURIComponent(playerId)}&limit=1`
    );
    const balancePoints = accounts[0]?.balance_points ?? "0";
    if (!/^\d+$/.test(String(balancePoints))) {
        throw new Error("Game-points balance query returned an invalid balance.");
    }
    return String(balancePoints);
}

module.exports = async function gamePoints(request, response) {
    if (handleApiCors(request, response)) return;
    if (request.method !== "GET" && request.method !== "POST") {
        response.setHeader("Allow", "GET, POST");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (!hasServiceDatabaseEnvironment()) {
        return sendJson(response, 503, { error: "game_points_api_not_configured" });
    }

    let playerId = null;
    try {
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });
        playerId = user.id;

        if (request.method === "GET") {
            return sendJson(response, 200, {
                balancePoints: await getBalance(user.id),
                balanceVerified: true
            });
        }

        const { action } = request.body ?? {};
        if (action === "claim") {
            const signature = request.body?.signature;
            if (typeof signature !== "string" || !signaturePattern.test(signature)) {
                return sendJson(response, 400, { error: "invalid_transaction_link" });
            }
            const [claim] = await serviceRequest("rpc/claim_game_points", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    p_player_id: user.id,
                    p_transaction_signature: signature
                })
            });
            if (!claim || !/^\d+$/.test(String(claim.balance_points))) {
                throw new Error("Game-points claim RPC returned an invalid balance.");
            }
            return sendJson(response, 200, {
                status: "confirmed",
                pointsAdded: claim.already_claimed ? "0" : "1000",
                alreadyClaimed: claim.already_claimed === true,
                balancePoints: String(claim.balance_points)
            });
        }

        if (action === "start") {
            const levelNumber = request.body?.levelNumber;
            const entryCostPoints = getLevelEntryCostCredits(levelNumber);
            if (entryCostPoints === null) {
                return sendJson(response, 400, { error: "invalid_level_number" });
            }
            const requestId = request.body?.requestId;
            if (typeof requestId !== "string" || !requestIdPattern.test(requestId)) {
                return sendJson(response, 400, { error: "invalid_entry_request_id" });
            }

            const [session] = await serviceRequest("rpc/start_game_point_level", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    p_player_id: user.id,
                    p_level_number: levelNumber,
                    p_request_id: requestId
                })
            });
            if (!session || typeof session.session_id !== "string" ||
                !/^\d+$/.test(String(session.balance_points)) ||
                String(session.entry_cost_points) !== String(entryCostPoints)) {
                throw new Error("Game-points entry RPC returned an invalid session.");
            }
            return sendJson(response, 200, {
                allowed: true,
                gamePoints: true,
                sessionId: session.session_id,
                balancePoints: String(session.balance_points),
                entryCostPoints: String(session.entry_cost_points)
            });
        }

        return sendJson(response, 400, { error: "invalid_action" });
    } catch (error) {
        console.error("Game-points request failed closed.", {
            status: error.status ?? 500,
            code: error.code ?? "game_points_request_failed"
        });
        if (error.code === "P0001") {
            try {
                return sendJson(response, 402, {
                    error: "insufficient_game_points",
                    balancePoints: await getBalance(playerId)
                });
            } catch (balanceError) {
                console.error("Insufficient-points response could not refresh the account balance.", {
                    status: balanceError.status ?? 500,
                    code: balanceError.code ?? "game_points_balance_read_failed"
                });
                return sendJson(response, 402, { error: "insufficient_game_points" });
            }
        }
        if (error.code === "55006") {
            return sendJson(response, 409, { error: "level_session_active" });
        }
        if (error.status === 404 && error.code === "PGRST202") {
            return sendJson(response, 503, { error: "game_points_migration_required" });
        }
        if (error.status === 404 && error.code === "PGRST205") {
            return sendJson(response, 503, { error: "game_points_schema_not_installed" });
        }
        return sendJson(response, 502, { error: "game_points_unavailable" });
    }
};
