const {
    authenticate,
    handleApiCors,
    hasServiceDatabaseEnvironment,
    serviceRequest,
    sendJson
} = require("./wallet");

module.exports = async function gamePoints(request, response) {
    if (handleApiCors(request, response)) return;
    if (request.method !== "GET" && request.method !== "POST") {
        response.setHeader("Allow", "GET, POST");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (request.method === "POST") {
        return sendJson(response, 410, { error: "separate_game_points_retired" });
    }
    if (!hasServiceDatabaseEnvironment()) {
        return sendJson(response, 503, { error: "wallet_api_not_configured" });
    }

    try {
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });
        const playerId = encodeURIComponent(user.id);
        const [accounts, walletCompletions, legacyCompletions] = await Promise.all([
            serviceRequest(`wallet_credit_accounts?select=balance_credits&player_id=eq.${playerId}&limit=1`),
            serviceRequest(`level_completions?select=level_number&player_id=eq.${playerId}`),
            serviceRequest(`game_point_level_completions?select=level_number&player_id=eq.${playerId}`)
        ]);
        const balanceCredits = String(accounts[0]?.balance_credits ?? "0");
        if (!/^\d+$/.test(balanceCredits)) {
            throw new Error("Canonical wallet account returned an invalid balance.");
        }
        const completedLevels = [...new Set([...walletCompletions, ...legacyCompletions]
            .map((row) => Number(row.level_number))
            .filter((levelNumber) => Number.isInteger(levelNumber) && levelNumber >= 1 && levelNumber <= 99))]
            .sort((a, b) => a - b);
        return sendJson(response, 200, { balanceCredits, completedLevels });
    } catch (error) {
        console.error("Canonical wallet progress could not be loaded.", {
            status: error.status ?? 500,
            code: error.code ?? "wallet_progress_read_failed"
        });
        return sendJson(response, 502, { error: "wallet_progress_unavailable" });
    }
};
