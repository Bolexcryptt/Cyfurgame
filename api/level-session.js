const {
    authenticate,
    handleApiCors,
    hasServiceDatabaseEnvironment,
    serviceRequest,
    sendJson
} = require("../server/lib/wallet");

module.exports = async function levelSession(request, response) {
    if (handleApiCors(request, response)) return;
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (!hasServiceDatabaseEnvironment()) {
        return sendJson(response, 503, { error: "wallet_api_not_configured" });
    }

    try {
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });
        const sessionId = request.body?.sessionId;
        if (typeof sessionId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
            return sendJson(response, 400, { error: "invalid_level_session" });
        }

        const startedAtResponse = await serviceRequest("rpc/start_wallet_level_timer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ p_player_id: user.id, p_session_id: sessionId })
        });
        const startedAt = Array.isArray(startedAtResponse) ? startedAtResponse[0] : startedAtResponse;
        if (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))) {
            throw new Error("Level timer RPC returned an invalid start time.");
        }
        return sendJson(response, 200, { startedAt });
    } catch (error) {
        console.error("Wallet level timer could not be started.", {
            status: error.status ?? 500,
            code: error.code ?? "level_timer_start_failed"
        });
        if (error.status === 404 && error.code === "PGRST202") {
            return sendJson(response, 503, { error: "wallet_migration_required" });
        }
        return sendJson(response, 502, { error: "level_timer_unavailable" });
    }
};
