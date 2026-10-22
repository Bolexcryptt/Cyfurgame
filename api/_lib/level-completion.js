const directionSteps = [
    { row: -1, col: 0 },
    { row: 0, col: 1 },
    { row: 1, col: 0 },
    { row: 0, col: -1 }
];
const slashReflection = [1, 0, 3, 2];
const backslashReflection = [3, 2, 1, 0];

function verifyLevelProof(level, mirrors, launchDirection) {
    if (!level || !Array.isArray(level.obstacles) || !Array.isArray(level.crystals) ||
        !Number.isInteger(level.start?.row) || !Number.isInteger(level.start?.col) ||
        !Number.isInteger(level.target?.row) || !Number.isInteger(level.target?.col) ||
        ![1, 3].includes(launchDirection) ||
        !Array.isArray(mirrors) || mirrors.length > 48) {
        return { connected: false, reason: "invalid_proof" };
    }

    const mirrorMap = new Map();
    const startKey = `${level.start.row},${level.start.col}`;
    const targetKey = `${level.target.row},${level.target.col}`;
    const obstacleKeys = new Set(level.obstacles.map(({ row, col }) => `${row},${col}`));
    const crystalMap = new Map(level.crystals.map((crystal, index) => [
        `${crystal.row},${crystal.col}`,
        { ...crystal, index }
    ]));

    for (const mirror of mirrors) {
        if (!Number.isInteger(mirror?.row) || mirror.row < 0 || mirror.row >= 6 ||
            !Number.isInteger(mirror?.col) || mirror.col < 0 || mirror.col >= 8 ||
            typeof mirror.slash !== "boolean") {
            return { connected: false, reason: "invalid_mirror" };
        }
        const key = `${mirror.row},${mirror.col}`;
        if (key === startKey || key === targetKey || obstacleKeys.has(key) ||
            crystalMap.has(key) || mirrorMap.has(key)) {
            return { connected: false, reason: "invalid_mirror_position" };
        }
        mirrorMap.set(key, mirror.slash);
    }

    let row = level.start.row;
    let col = level.start.col;
    let direction = launchDirection;
    let reflections = 0;
    let nextCrystalIndex = 0;
    let colorIndex = 0;
    const visited = new Set();

    for (let step = 0; step < 6 * 8 * 4; step++) {
        const state = `${row},${col},${direction}`;
        if (visited.has(state)) return { connected: false, reason: "loop" };
        visited.add(state);

        row += directionSteps[direction].row;
        col += directionSteps[direction].col;
        if (row < 0 || row >= 6 || col < 0 || col >= 8) {
            return { connected: false, reason: "edge" };
        }
        const key = `${row},${col}`;
        if (key === targetKey) {
            return nextCrystalIndex === level.crystals.length && reflections >= level.par
                ? { connected: true, reflections }
                : {
                    connected: false,
                    reason: nextCrystalIndex !== level.crystals.length ? "crystal_missed" : "underpowered"
                };
        }
        if (obstacleKeys.has(key)) return { connected: false, reason: "blocked" };

        const crystal = crystalMap.get(key);
        if (crystal) {
            if (crystal.index !== nextCrystalIndex || crystal.inputColor !== colorIndex % 3) {
                return { connected: false, reason: "crystal_mismatch" };
            }
            nextCrystalIndex++;
            colorIndex = crystal.outputColor;
        }
        if (mirrorMap.has(key)) {
            direction = mirrorMap.get(key)
                ? slashReflection[direction]
                : backslashReflection[direction];
            reflections++;
            colorIndex++;
        }
    }

    return { connected: false, reason: "step_limit" };
}

async function getLevelEconomyAndStars(levelNumber, elapsedMilliseconds) {
    const { evaluateLevelStars, getLevelEconomy, levels } = await import("../../levels.js");
    const level = levels[levelNumber - 1];
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
