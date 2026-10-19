const ROWS = 6;
const COLS = 8;
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
            obstacles
        });
        if (usedLayouts.has(layoutKey)) continue;

        usedLayouts.add(layoutKey);
        return Object.freeze({
            number,
            title: `SECTOR ${String(number).padStart(2, "0")}`,
            band,
            start: Object.freeze(start),
            target: Object.freeze(target),
            solutionMirrors: Object.freeze(solutionMirrors.map(Object.freeze)),
            obstacles: Object.freeze(obstacles.map(Object.freeze)),
            route: Object.freeze(route.map(Object.freeze)),
            par: solutionMirrors.length
        });
    }

    throw new Error(`Unable to generate a unique solvable layout for level ${number}.`);
}

const layouts = new Set();
export const levels = Object.freeze(
    Array.from({ length: 99 }, (_, index) => makeLevel(index + 1, layouts))
);
