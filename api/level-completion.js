const {
    authenticate,
    handleApiCors,
    hasServiceDatabaseEnvironment,
    serviceRequest,
    sendJson
} = require("../server/lib/wallet");
const { getLevelEconomyAndStars, verifyLevelProof } = require("../server/lib/level-completion");
const { areLevelsGloballyLocked } = require("../server/lib/level-lock");

async function completeLevelSession(rpcName, options) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await serviceRequest(rpcName, options);
        } catch (error) {
            const retryableStatus = [429, 500, 502, 503, 504].includes(error.status);
            const retryableCode = [
                "ECONNRESET",
                "ETIMEDOUT",
                "ECONNREFUSED",
                "EAI_AGAIN",
                "UND_ERR_CONNECT_TIMEOUT",
                "UND_ERR_SOCKET"
            ].includes(error.code);
            const retryableNetworkError = error.name === "TypeError" && error.status === undefined;
            if (attempt === 2 ||
                (!retryableStatus && !retryableCode && !retryableNetworkError)) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
    }
    throw new Error("Level completion could not be confirmed.");
}

module.exports = async function levelCompletion(request, response) {
    if (handleApiCors(request, response)) return;
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (areLevelsGloballyLocked()) {
        return sendJson(response, 423, {
            error: "levels_locked",
            levelsLocked: true
        });
    }
    if (!hasServiceDatabaseEnvironment()) {
        return sendJson(response, 503, { error: "wallet_api_not_configured" });
    }

    let failureStage = "authentication";
    try {
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });

        const { sessionId, mirrors, launchDirection, gamePoints } = request.body ?? {};
        if (gamePoints !== undefined && typeof gamePoints !== "boolean") {
            return sendJson(response, 400, { error: "invalid_completion_proof" });
        }
        if (gamePoints === true) {
            return sendJson(response, 410, { error: "separate_game_points_retired" });
        }
        if (typeof sessionId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId) ||
            !Array.isArray(mirrors) || ![1, 3].includes(launchDirection)) {
            return sendJson(response, 400, { error: "invalid_completion_proof" });
        }

        failureStage = "session_lookup";
        const sessions = await serviceRequest(
            `wallet_level_sessions?select=id,player_id,level_number,timer_started_at,expires_at,completed_at,layout_seed&id=eq.${encodeURIComponent(sessionId)}&player_id=eq.${encodeURIComponent(user.id)}&limit=1`
        );
        const session = sessions[0];
        if (!session) return sendJson(response, 403, { error: "level_session_not_found" });
        const rpcName = "rpc/complete_wallet_level";
        if (session.completed_at) {
            const [result] = await completeLevelSession(rpcName, {
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
        const layoutSeed = Number(session.layout_seed);
        if (!/^\d+$/.test(String(session.layout_seed)) ||
            !Number.isSafeInteger(layoutSeed) || layoutSeed < 0 || layoutSeed > 0xffffffff) {
            return sendJson(response, 409, { error: "level_session_variant_unavailable" });
        }

        const elapsedMilliseconds = Date.now() - Date.parse(session.timer_started_at);
        if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) {
            return sendJson(response, 422, { error: "invalid_server_timer" });
        }
        failureStage = "level_configuration";
        const { level, economy, result: starsResult } = await getLevelEconomyAndStars(
            session.level_number,
            elapsedMilliseconds,
            layoutSeed
        );
        failureStage = "proof_verification";
        const proof = await verifyLevelProof(level, mirrors, launchDirection);
        if (!proof.connected) {
            return sendJson(response, 422, {
                error: "battery_not_connected",
                reason: proof.reason
            });
        }
        const rewardAmount = starsResult.stars === 3
            ? economy.threeStarPayoutCredits
            : starsResult.stars === 2
                ? economy.twoStarRefundCredits
                : 0;

        failureStage = "completion_rpc";
        const [completion] = await completeLevelSession(rpcName, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                p_player_id: user.id,
                p_session_id: sessionId,
                p_stars: starsResult.stars,
                p_reward_credits: rewardAmount,
                p_elapsed_milliseconds: elapsedMilliseconds
            })
        });
        if (!completion || !/^\d+$/.test(String(completion.balance_credits))) {
            failureStage = "completion_response";
            throw new Error("Level completion RPC returned an invalid result.");
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
        console.error("Level completion failed closed.", {
            status: error.status ?? 500,
            code: error.code ?? "level_completion_failed",
            stage: failureStage
        });
        if (error.code === "PGRST202") {
            return sendJson(response, 503, { error: "wallet_migration_required" });
        }
        if (error.code === "PGRST205") {
            return sendJson(response, 503, { error: "wallet_schema_not_installed" });
        }
        if (error.code === "42702" || error.code === "42703") {
            return sendJson(response, 503, { error: "wallet_migration_required" });
        }
        if (error.code === "P0002") {
            return sendJson(response, 403, { error: "level_session_not_found" });
        }
        if (error.code === "22023") {
            if (/has not started or has expired/i.test(error.databaseMessage ?? "")) {
                return sendJson(response, 422, { error: "level_session_not_started_or_expired" });
            }
            if (/reward does not match/i.test(error.databaseMessage ?? "")) {
                return sendJson(response, 503, { error: "wallet_migration_required" });
            }
            const reasonByMessage = new Map([
                ["Invalid level completion.", "invalid_completion_parameters"],
                ["Invalid wallet ledger entry.", "invalid_reward_ledger_entry"],
                ["Insufficient credits.", "wallet_balance_rejected"]
            ]);
            return sendJson(response, 422, {
                error: "invalid_level_completion",
                reason: reasonByMessage.get(error.databaseMessage) ?? "database_rejected_completion",
                diagnosticCode: error.code,
                stage: failureStage
            });
        }
        const diagnosticCode = /^[A-Z0-9]{4,8}$/.test(error.code ?? "")
            ? error.code
            : undefined;
        return sendJson(response, 502, {
            error: "level_completion_unavailable",
            ...(diagnosticCode ? { diagnosticCode, stage: failureStage } : {})
        });
    }
};
