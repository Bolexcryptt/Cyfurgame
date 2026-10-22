const ROWS = 6;
const COLS = 8;
export const CYFUR_CREDITS_PER_TOKEN = 10000;
export const STAR_TIME_CONFIG = Object.freeze({
    threeStarBaseSeconds: 25,
    threeStarSecondsPerMirror: 10,
    twoStarBaseSeconds: 60,
    twoStarSecondsPerMirror: 20
});
export const LEVEL_STAR_TIME_OVERRIDES = Object.freeze({});

export function getLevelStarTimeTargets(level) {
    const complexity = Math.max(1, level?.par ?? 1);
    const defaults = {
        threeSeconds: STAR_TIME_CONFIG.threeStarBaseSeconds + complexity * STAR_TIME_CONFIG.threeStarSecondsPerMirror,
        twoSeconds: STAR_TIME_CONFIG.twoStarBaseSeconds + complexity * STAR_TIME_CONFIG.twoStarSecondsPerMirror
    };
    const overrides = LEVEL_STAR_TIME_OVERRIDES[level?.number] ?? {};
    const targets = {
        threeSeconds: overrides.threeSeconds ?? defaults.threeSeconds,
        twoSeconds: overrides.twoSeconds ?? defaults.twoSeconds
    };
    if (!Number.isFinite(targets.threeSeconds) || !Number.isFinite(targets.twoSeconds) ||
        targets.threeSeconds < 0 || targets.twoSeconds <= targets.threeSeconds) {
        throw new RangeError(`Invalid star-time thresholds for level ${level?.number ?? "unknown"}.`);
    }
    return targets;
}
const DIRECTIONS = [
    { row: -1, col: 0 },
    { row: 0, col: 1 },
    { row: 1, col: 0 },
    { row: 0, col: -1 }
];
const SLASH = [1, 0, 3, 2];
const BACKSLASH = [3, 2, 1, 0];

function randomFor(seed) {
    let value = seed >>> 0;
    return () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 4294967296;
    };
}

function reflect(incoming, outgoing) {
    if (SLASH[incoming] === outgoing) return "/";
    if (BACKSLASH[incoming] === outgoing) return "\\";
    throw new Error(`Cannot reflect direction ${incoming} into ${outgoing}.`);
}

function buildRoute(random, start, target, minimumTurns) {
    const path = [{ row: start.row, col: start.col, direction: start.direction }];
    const used = new Set([`${start.row},${start.col}`]);
    let explored = 0;

    function search(row, col, incoming, turns, depth) {
        explored++;
        if (explored > 18000 || depth > ROWS * COLS - 1) return null;
        if (row === target.row && col === target.col) {
            return turns === minimumTurns ? path.slice() : null;
        }

        const options = depth === 0
            ? [incoming]
            : [incoming, (incoming + 1) % 4, (incoming + 3) % 4];
        for (let i = options.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [options[i], options[j]] = [options[j], options[i]];
        }

        for (const outgoing of options) {
            const delta = DIRECTIONS[outgoing];
            const nextRow = row + delta.row;
            const nextCol = col + delta.col;
            const key = `${nextRow},${nextCol}`;
            if (nextRow < 0 || nextRow >= ROWS || nextCol < 0 || nextCol >= COLS || used.has(key)) continue;

            const nextTurns = turns + Number(outgoing !== incoming);
            if (nextTurns > minimumTurns) continue;
            if (nextRow === target.row && nextCol === target.col && nextTurns < minimumTurns) continue;

            used.add(key);
            path.push({ row: nextRow, col: nextCol, direction: outgoing });
            const result = search(nextRow, nextCol, outgoing, nextTurns, depth + 1);
            if (result) return result;
            path.pop();
            used.delete(key);
        }
        return null;
    }

    return search(start.row, start.col, start.direction, 0, 0);
}

function makeLevel(number, usedLayouts) {
    const band = Math.ceil(number / 10);
    const requiredTurns = band;

    for (let attempt = 0; attempt < 300; attempt++) {
        const random = randomFor(number * 7919 + attempt * 104729);
        const start = {
            row: Math.floor(random() * ROWS),
            col: Math.floor(random() * 2) === 0 ? 2 : 5,
            direction: random() < 0.5 ? 1 : 3
        };
        const target = {
            row: Math.floor(random() * ROWS),
            col: Math.floor(random() * COLS)
        };
        const distance = Math.abs(start.row - target.row) + Math.abs(start.col - target.col);
        if (distance < 4 || (target.row === start.row && target.col === start.col)) continue;

        const route = buildRoute(random, start, target, requiredTurns);
        if (!route) continue;

        const solutionMirrors = [];
        for (let i = 0; i < route.length - 1; i++) {
            const here = route[i];
            const next = route[i + 1];
            if (here.direction !== next.direction) {
                solutionMirrors.push({
                    row: here.row,
                    col: here.col,
                    orientation: reflect(here.direction, next.direction)
                });
            }
        }
        if (solutionMirrors.length < requiredTurns) continue;

        const straightRouteCells = [];
        for (let i = 1; i < route.length - 1; i++) {
            if (route[i].direction === route[i + 1].direction) {
                straightRouteCells.push(route[i]);
            }
        }
        const crystalCount = 1 + Math.floor((band - 1) / 2);
        if (straightRouteCells.length < crystalCount) continue;
        for (let i = straightRouteCells.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [straightRouteCells[i], straightRouteCells[j]] = [straightRouteCells[j], straightRouteCells[i]];
        }
        const crystals = straightRouteCells
            .slice(0, crystalCount)
            .sort((a, b) => route.indexOf(a) - route.indexOf(b))
            .map(({ row, col }, index) => {
                const routeIndex = route.findIndex((cell) => cell.row === row && cell.col === col);
                const mirrorsBefore = solutionMirrors.filter((mirror) =>
                    route.findIndex((cell) => cell.row === mirror.row && cell.col === mirror.col) < routeIndex
                ).length;
                const inputColor = (mirrorsBefore + index) % 3;
                return { row, col, inputColor, outputColor: (inputColor + 1) % 3 };
            });

        const pathCells = new Set(route.map(({ row, col }) => `${row},${col}`));
        const candidates = [];
        for (let row = 0; row < ROWS; row++) {
            for (let col = 0; col < COLS; col++) {
                const key = `${row},${col}`;
                if (!pathCells.has(key)) candidates.push({ row, col });
            }
        }
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        const obstacleCount = Math.min(1 + band, candidates.length);
        const obstacles = candidates.slice(0, obstacleCount);
        const layoutKey = JSON.stringify({
            start,
            target,
            solutionMirrors,
            crystals,
            obstacles
        });
        if (usedLayouts.has(layoutKey)) continue;

        usedLayouts.add(layoutKey);
        const par = solutionMirrors.length;
        const entryCost = Math.floor(100 * Math.pow(1.08, number - 1));
        const starTimeTargets = getLevelStarTimeTargets({ number, par });
        return Object.freeze({
            number,
            title: `SECTOR ${String(number).padStart(2, "0")}`,
            band,
            start: Object.freeze(start),
            target: Object.freeze(target),
            solutionMirrors: Object.freeze(solutionMirrors.map(Object.freeze)),
            crystals: Object.freeze(crystals.map(Object.freeze)),
            obstacles: Object.freeze(obstacles.map(Object.freeze)),
            route: Object.freeze(route.map(Object.freeze)),
            par,
            economy: Object.freeze({
                entryCostCredits: entryCost,
                threeStarPayoutCredits: Math.floor(entryCost * 1.6),
                twoStarRefundCredits: Math.floor(entryCost * 0.4),
                oneStarPayoutCredits: 0
            }),
            starTimeTargets: Object.freeze(starTimeTargets)
        });
    }

    throw new Error(`Unable to generate a unique solvable layout for level ${number}.`);
}

export function getLevelEconomy(levelNumber) {
    if (!Number.isInteger(levelNumber) || levelNumber < 1 || levelNumber > 99) {
        throw new Error(`Level ${levelNumber} is outside the RelicGrid campaign.`);
    }
    const entryCostCredits = Math.floor(100 * Math.pow(1.08, levelNumber - 1));
    return {
        entryCostCredits,
        threeStarPayoutCredits: Math.floor(entryCostCredits * 1.6),
        twoStarRefundCredits: Math.floor(entryCostCredits * 0.4),
        oneStarPayoutCredits: 0
    };
}

export function evaluateLevelStars(level, elapsedMilliseconds, connected = true) {
    if (!level || !Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0 || !connected) {
        return { stars: 0, rewardCredits: 0, status: "fail" };
    }
    const timeTargets = level.starTimeTargets ?? getLevelStarTimeTargets(level);
    if (!Number.isFinite(timeTargets.threeSeconds) || !Number.isFinite(timeTargets.twoSeconds) ||
        timeTargets.threeSeconds < 0 || timeTargets.twoSeconds <= timeTargets.threeSeconds) {
        throw new RangeError(`Invalid star-time thresholds for level ${level.number ?? "unknown"}.`);
    }
    const elapsedSeconds = elapsedMilliseconds / 1000;
    let stars = 0;
    let rewardCredits = 0;
    if (elapsedSeconds <= timeTargets.threeSeconds) {
        stars = 3;
        rewardCredits = level.economy?.threeStarPayoutCredits ?? 0;
    } else if (elapsedSeconds <= timeTargets.twoSeconds) {
        stars = 2;
        rewardCredits = level.economy?.twoStarRefundCredits ?? 0;
    } else {
        stars = 1;
        rewardCredits = 0;
    }
    return { stars, rewardCredits, status: "completed" };
}

export function calculateSolveTimeMilliseconds(startedAt, connectedAt, batteryConnected) {
    if (!batteryConnected || !Number.isFinite(startedAt) || !Number.isFinite(connectedAt) || connectedAt < startedAt) {
        return null;
    }
    return connectedAt - startedAt;
}

export function claimLevelCompletion(levelNumber, seenLevels) {
    if (!Number.isInteger(levelNumber) || levelNumber < 1 || levelNumber > 99) return false;
    if (!(seenLevels instanceof Set) || seenLevels.has(levelNumber)) return false;
    seenLevels.add(levelNumber);
    return true;
}

const layouts = new Set();
export const levels = Object.freeze(
    Array.from({ length: 99 }, (_, index) => makeLevel(index + 1, layouts))
);
