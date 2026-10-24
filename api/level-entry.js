const {
    authenticate,
    handleApiCors,
    getLevelEntryCostCredits,
    hasServiceDatabaseEnvironment,
    hasWalletEnvironment,
    selectOwn,
    serviceRequest,
    sendJson
} = require("../server/lib/wallet");

module.exports = async function levelEntry(request, response) {
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

        const levelNumber = request.body?.levelNumber;
        const entryCostCredits = getLevelEntryCostCredits(levelNumber);
        if (entryCostCredits === null) {
            return sendJson(response, 400, { error: "invalid_level_number" });
        }

        const completions = await selectOwn(request, "level_completions", new URLSearchParams({
            select: "level_number",
            player_id: `eq.${user.id}`,
            order: "level_number.asc",
            limit: "99"
        }));
        const unlockedLevel = completions.reduce(
            (nextLevel, completion) => completion.level_number === nextLevel ? nextLevel + 1 : nextLevel,
            1
        );
        if (levelNumber > unlockedLevel) {
            return sendJson(response, 403, {
                error: "level_locked",
                unlockedLevel: Math.min(99, unlockedLevel)
            });
        }

        const accounts = await selectOwn(request, "wallet_credit_accounts", new URLSearchParams({
            select: "balance_credits",
            player_id: `eq.${user.id}`,
            limit: "1"
        }));
        const balance = accounts[0]?.balance_credits;
        if (balance === undefined || !/^\d+$/.test(String(balance))) {
            return sendJson(response, 503, { error: "verified_balance_unavailable" });
        }

        const baseResponse = {
            balanceCredits: String(balance),
            balanceVerified: true,
            entryCostCredits
        };
        let paidGameplayConfigured = false;
        if (hasServiceDatabaseEnvironment() && process.env.WALLET_PAID_GAMEPLAY_ENABLED === "true") {
            const configs = await serviceRequest(
                "wallet_system_config?select=paid_gameplay_enabled&id=eq.1"
            );
            paidGameplayConfigured = configs[0]?.paid_gameplay_enabled === true;
        }
        if (!paidGameplayConfigured) {
            if (BigInt(balance) < BigInt(entryCostCredits)) {
                return sendJson(response, 402, {
                    ...baseResponse,
                    error: "insufficient_balance"
                });
            }
            return sendJson(response, 503, {
                ...baseResponse,
                error: "paid_gameplay_disabled",
                paidGameplayEnabled: false
            });
        }

        const requestId = request.body?.requestId;
        if (typeof requestId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
            return sendJson(response, 400, { error: "invalid_entry_request_id" });
        }
        const [session] = await serviceRequest("rpc/start_wallet_level", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                p_player_id: user.id,
                p_level_number: levelNumber,
                p_request_id: requestId
            })
        });
        if (!session || typeof session.session_id !== "string" ||
            !/^\d+$/.test(String(session.balance_credits))) {
            throw new Error("Level-entry RPC returned an invalid session.");
        }
        return sendJson(response, 200, {
            ...baseResponse,
            allowed: true,
            paidGameplayEnabled: true,
            sessionId: session.session_id,
            balanceCredits: String(session.balance_credits),
            entryCostCredits: Number(session.entry_cost_credits)
        });
    } catch (error) {
        console.error("Paid level access check failed closed.", {
            status: error.status ?? 500,
            code: error.code ?? "level_access_check_failed"
        });
        if (error.status === 404 && error.code === "PGRST205") {
            return sendJson(response, 503, { error: "wallet_schema_not_installed" });
        }
        if (error.code === "P0001") {
            return sendJson(response, 402, { error: "insufficient_balance" });
        }
        if (error.code === "55000") {
            return sendJson(response, 503, { error: "paid_gameplay_disabled", paidGameplayEnabled: false });
        }
        if (error.code === "PGRST202") {
            return sendJson(response, 503, { error: "wallet_migration_required" });
        }
        if (error.code === "42703") {
            return sendJson(response, 503, { error: "wallet_migration_required" });
        }
        return sendJson(response, 502, { error: "level_access_check_unavailable" });
    }
};
