const { handleApiCors, sendJson } = require("../server/lib/wallet");
const { areLevelsGloballyLocked } = require("../server/lib/level-lock");

module.exports = function gameConfig(request, response) {
    if (handleApiCors(request, response)) return;
    if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }

    return sendJson(response, 200, {
        levelsLocked: areLevelsGloballyLocked()
    });
};
