const {
    authenticate,
    handleApiCors,
    hasServiceDatabaseEnvironment,
    serviceRequest,
    sendJson
} = require("../server/lib/wallet");
const { getLevelEconomyAndStars, verifyLevelProof } = require("../server/lib/level-completion");

module.exports = async function levelCompletion(request, response) {
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

        const { sessionId, mirrors, launchDirection } = request.body ?? {};
        if (typeof sessionId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId) ||
            !Array.isArray(mirrors) || ![1, 3].includes(launchDirection)) {
            return sendJson(response, 400, { error: "invalid_completion_proof" });
        }

        const sessions = await serviceRequest(
            `wallet_level_sessions?select=id,player_id,level_number,timer_started_at,expires_at,completed_at&id=eq.${encodeURIComponent(sessionId)}&player_id=eq.${encodeURIComponent(user.id)}&limit=1`
        );
        const session = sessions[0];
        if (!session) return sendJson(response, 403, { error: "level_session_not_found" });
        if (session.completed_at) {
            const [result] = await serviceRequest("rpc/complete_wallet_level", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    p_player_id: user.id,
                    p_session_id: sessionId,
                    p_stars: 1,
                    p_reward_credits: 0,
                    p_elapsed_milliseconds: 0
                })
            });
            return sendJson(response, 200, {
                status: "confirmed",
                duplicate: true,
                stars: result.stars,
                rewardCredits: String(result.reward_credits),
                elapsedMilliseconds: Number(result.elapsed_milliseconds),
                balanceCredits: String(result.balance_credits)
            });
        }
        if (!session.timer_started_at || Date.parse(session.expires_at) <= Date.now()) {
            return sendJson(response, 422, { error: "level_session_not_started_or_expired" });
        }

        const elapsedMilliseconds = Date.now() - Date.parse(session.timer_started_at);
        if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) {
            return sendJson(response, 422, { error: "invalid_server_timer" });
        }
        const { level, economy, result: starsResult } = await getLevelEconomyAndStars(
            session.level_number,
            elapsedMilliseconds
        );
        const proof = verifyLevelProof(level, mirrors, launchDirection);
        if (!proof.connected) {
            return sendJson(response, 422, {
                error: "battery_not_connected",
                reason: proof.reason
            });
        }
        const rewardCredits = starsResult.stars === 3
            ? economy.threeStarPayoutCredits
            : starsResult.stars === 2
                ? economy.twoStarRefundCredits
                : 0;

        const [completion] = await serviceRequest("rpc/complete_wallet_level", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                p_player_id: user.id,
                p_session_id: sessionId,
                p_stars: starsResult.stars,
                p_reward_credits: rewardCredits,
                p_elapsed_milliseconds: elapsedMilliseconds
            })
        });
        if (!completion || !/^\d+$/.test(String(completion.balance_credits))) {
            throw new Error("Wallet completion RPC returned an invalid result.");
        }

        return sendJson(response, 200, {
            status: "confirmed",
            duplicate: completion.already_completed === true,
            stars: completion.stars,
            rewardCredits: String(completion.reward_credits),
            elapsedMilliseconds: Number(completion.elapsed_milliseconds),
            balanceCredits: String(completion.balance_credits),
            entryCostCredits: economy.entryCostCredits
        });
    } catch (error) {
        console.error("Wallet level completion failed closed.", {
            status: error.status ?? 500,
            code: error.code ?? "level_completion_failed"
        });
        if (error.status === 404 && error.code === "PGRST202") {
            return sendJson(response, 503, { error: "wallet_migration_required" });
        }
        if (error.status === 404 && error.code === "PGRST205") {
            return sendJson(response, 503, { error: "wallet_schema_not_installed" });
        }
        return sendJson(response, 502, { error: "level_completion_unavailable" });
    }
};
