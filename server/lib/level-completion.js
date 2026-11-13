async function verifyLevelProof(level, mirrors, launchDirection) {
    if (!level || !Array.isArray(level.obstacles) || !Array.isArray(level.crystals) ||
        !Number.isInteger(level.start?.row) || level.start.row < 0 || level.start.row >= 6 ||
        !Number.isInteger(level.target?.row) || !Number.isInteger(level.target?.col) ||
        ![1, 3].includes(launchDirection) ||
        !Array.isArray(mirrors) || mirrors.length > 48) {
        return { connected: false, reason: "invalid_proof" };
    }

    const targetKey = `${level.target.row},${level.target.col}`;
    const obstacleKeys = new Set(level.obstacles.map(({ row, col }) => `${row},${col}`));
    const crystalMap = new Map(level.crystals.map((crystal, index) => [
        `${crystal.row},${crystal.col}`,
        { ...crystal, index }
    ]));
    const mirrorMap = new Map();

    for (const mirror of mirrors) {
        if (!Number.isInteger(mirror?.row) || mirror.row < 0 || mirror.row >= 6 ||
            !Number.isInteger(mirror?.col) || mirror.col < 0 || mirror.col >= 8 ||
            typeof mirror.slash !== "boolean") {
            return { connected: false, reason: "invalid_mirror" };
        }
        const key = `${mirror.row},${mirror.col}`;
        if (key === targetKey || obstacleKeys.has(key) ||
            crystalMap.has(key) || mirrorMap.has(key)) {
            return { connected: false, reason: "invalid_mirror_position" };
        }
        mirrorMap.set(key, mirror.slash);
    }

    const { traceLaserRoute } = await import("../../levels.js");
    const route = traceLaserRoute(level, new Map(
        [...mirrorMap].map(([key, slash]) => [key, slash ? "/" : "\\"])
    ), launchDirection);
    return route.outcome === "powered"
        ? { connected: true, reflections: route.reflections }
        : { connected: false, reason: route.outcome };
}

async function getLevelEconomyAndStars(levelNumber, elapsedMilliseconds, layoutSeed) {
    const { evaluateLevelStars, getLevelEconomy, generateLevelVariant } = await import("../../levels.js");
    if (!Number.isSafeInteger(layoutSeed) || layoutSeed < 0 || layoutSeed > 0xffffffff) {
        throw new RangeError("A valid server-issued level layout seed is required.");
    }
    let level;
    try {
        level = generateLevelVariant(levelNumber, layoutSeed, []);
    } catch (error) {
        throw new RangeError(`Level ${levelNumber} layout could not be generated: ${error.message}`);
    }
    if (!level || level.number !== levelNumber) {
        throw new RangeError("Level configuration is unavailable.");
    }
    return {
        level,
        economy: getLevelEconomy(levelNumber),
        result: evaluateLevelStars(level, elapsedMilliseconds, true)
    };
}

module.exports = { getLevelEconomyAndStars, verifyLevelProof };
