(() => {
    "use strict";

    const SIZE = 8;
    const BLOCKERS = new Set([
        "0,1", "0,5", "1,1", "1,5", "3,1", "3,5", "4,2",
        "4,6", "5,2", "5,6", "6,6", "7,2", "7,5"
    ]);

    // The laser begins at the left side and initially travels east.
    const START = { r: 6, c: 0, dir: "E" };

    // The battery target.
    const TARGET = { r: 2, c: 7 };

    const DIRS = {
        N: { dr: -1, dc: 0 },
        E: { dr: 0, dc: 1 },
        S: { dr: 1, dc: 0 },
        W: { dr: 0, dc: -1 }
    };

    // A /-shaped mirror reflection.
    const SLASH_REFLECTION = {
        N: "E",
        E: "N",
        S: "W",
        W: "S"
    };

    // A \-shaped mirror reflection.
    const BACKSLASH_REFLECTION = {
        N: "W",
        W: "N",
        S: "E",
        E: "S"
    };

    const board = document.getElementById("game-board");
    const boardFrame = document.querySelector(".board-frame");
    const fireBtn = document.getElementById("fire-btn");
    const resetBtn = document.getElementById("reset-btn");
    const rotationInput = document.getElementById("board-rotation");
    const tiltInput = document.getElementById("board-tilt");
    const rotationValue = document.getElementById("rotation-value");
    const tiltValue = document.getElementById("tilt-value");
    const resetViewBtn = document.getElementById("reset-view-btn");

    const statusCard = document.getElementById("status-card");
    const statusTitle = document.getElementById("status-title");
    const statusMessage = document.getElementById("status-message");

    const winOverlay = document.getElementById("win-overlay");
    const continueBtn = document.getElementById("continue-btn");
    const progressBar = document.getElementById("level-progress");

    const mirrors = new Map();
    const cells = new Map();

    let beamElements = [];
    let traceTimer = null;
    let tracing = false;
    let won = false;

    const LASER_COLORS = ["#ff78dc", "#ffc15d", "#62dfff", "#ff78dc"];
    const DEFAULT_ROTATION = 325;
    const DEFAULT_TILT = 52;

    const key = (r, c) => `${r},${c}`;

    /* BUILD THE BOARD */

    function createBoard() {
        board.innerHTML = "";
        cells.clear();

        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                const cell = document.createElement("button");

                cell.type = "button";
                cell.className = "cell";
                cell.dataset.r = r;
                cell.dataset.c = c;

                cell.setAttribute("role", "gridcell");
                cell.setAttribute(
                    "aria-label",
                    `Row ${r + 1}, column ${c + 1}`
                );

                if (BLOCKERS.has(key(r, c))) {
                    cell.classList.add("blocked-cell");
                    cell.setAttribute(
                        "aria-label",
                        `Row ${r + 1}, column ${c + 1}, blocked by a fixed stone`
                    );
                    cell.innerHTML = `
                        <span class="stone-block" aria-hidden="true">
                            <span class="stone-face"></span>
                            <span class="stone-crack"></span>
                        </span>
                    `;
                }

                cell.addEventListener("click", () => {
                    handleCellClick(r, c);
                });

                board.appendChild(cell);
                cells.set(key(r, c), cell);
            }
        }

        paintFixedObjects();
    }

    function paintFixedObjects() {
        const sourceCell = cells.get(key(START.r, START.c));

        sourceCell.innerHTML = `
            <span class="emitter" aria-hidden="true">
                <span class="emitter-ring"></span>
                <span class="emitter-core"></span>
                <span class="emitter-arrow"></span>
            </span>
        `;

        sourceCell.classList.add("source-cell");
        sourceCell.setAttribute(
            "aria-label",
            "Laser emitter, initially pointing right"
        );

        const targetCell = cells.get(key(TARGET.r, TARGET.c));

        targetCell.innerHTML = `
            <span class="battery" aria-hidden="true">
                <span class="battery-shell">
                    <span class="battery-charge"></span>
                </span>
            </span>
        `;

        targetCell.classList.add("target-cell");
        targetCell.setAttribute("aria-label", "Power cell target");
    }

    /* MIRROR INTERACTIONS */

    function handleCellClick(r, c) {
        if (tracing || won) return;
        if (BLOCKERS.has(key(r, c))) {
            setStatus(
                "Tile blocked",
                "A fixed stone occupies this tile. Place your mirror on an open tile.",
                "error"
            );
            return;
        }
        if (isFixed(r, c)) return;

        const cellKey = key(r, c);

        if (mirrors.has(cellKey)) {
            // Rotate an existing mirror between / and \.
            const mirror = mirrors.get(cellKey);
            mirror.slash = !mirror.slash;

            renderMirror(r, c);

            setStatus(
                "Mirror rotated",
                "Reflector angle changed. Trace the beam to test the route.",
                "ready"
            );
        } else {
            // Place a new mirror on an empty tile.
            mirrors.set(cellKey, { slash: true });

            renderMirror(r, c);

            setStatus(
                "Mirror placed",
                "Tap a placed mirror to rotate it. Trace the laser when ready.",
                "ready"
            );
        }

        clearTrace();
    }

    function isFixed(r, c) {
        return (
            (r === START.r && c === START.c) ||
            (r === TARGET.r && c === TARGET.c)
        );
    }

    function renderMirror(r, c) {
        const cell = cells.get(key(r, c));
        const mirror = mirrors.get(key(r, c));

        cell.classList.add("mirror-cell");

        cell.innerHTML = `
            <span class="mirror-prop"
                  style="--mirror-facing:${mirror.slash ? "-45deg" : "45deg"}"
                  aria-hidden="true"></span>
        `;

        cell.setAttribute(
            "aria-label",
            `Row ${r + 1}, column ${c + 1}, mirror. Tap to rotate.`
        );
    }

    /* CLEAR THE PREVIOUS LASER */

    function clearTrace() {
        if (traceTimer !== null) {
            clearTimeout(traceTimer);
            traceTimer = null;
        }

        tracing = false;

        beamElements.forEach(element => element.remove());
        beamElements = [];

        board.querySelectorAll(".beam-trail").forEach(cell => {
            cell.classList.remove("beam-trail");
        });

        const battery = cells
            .get(key(TARGET.r, TARGET.c))
            .querySelector(".battery");

        if (battery) {
            battery.classList.remove("powered");
        }

        fireBtn.disabled = false;
        fireBtn.innerHTML = `
            <span class="play-symbol">▶</span>
            POWER THE CELL
            <span class="button-arrow">↗</span>
        `;
    }

    /* CALCULATE THE REAL LASER PATH */

    function calculatePath() {
        let r = START.r;
        let c = START.c;
        let direction = START.dir;

        const points = [{ r, c }];
        const segmentColors = [];
        const visited = new Set();

        let outcome = "edge";
        let reflectionCount = 0;

        for (let step = 0; step < 100; step++) {
            const movement = DIRS[direction];

            r += movement.dr;
            c += movement.dc;

            // The laser has left the chamber.
            if (
                r < 0 || r >= SIZE ||
                c < 0 || c >= SIZE
            ) {
                outcome = "edge";
                break;
            }

            points.push({ r, c });
            segmentColors.push(LASER_COLORS[reflectionCount % LASER_COLORS.length]);

            // Stop infinite reflection loops.
            const state = `${r},${c},${direction}`;

            if (visited.has(state)) {
                outcome = "loop";
                break;
            }

            visited.add(state);

            // The battery has been reached.
            if (r === TARGET.r && c === TARGET.c) {
                outcome = "win";
                break;
            }

            // Fixed stones absorb the beam and cannot hold mirrors.
            if (BLOCKERS.has(key(r, c))) {
                outcome = "blocked";
                break;
            }

            // Reflect the beam if a mirror occupies this tile.
            const mirror = mirrors.get(key(r, c));

            if (mirror) {
                reflectionCount++;
                direction = mirror.slash
                    ? SLASH_REFLECTION[direction]
                    : BACKSLASH_REFLECTION[direction];
            }
        }

        return { points, segmentColors, outcome };
    }

    /* DRAW THE LASER */

    function drawSegment(from, to, color) {
        const fromCell = cells.get(key(from.r, from.c));
        const toCell = cells.get(key(to.r, to.c));

        if (!fromCell || !toCell) return;

        const cellWidth = board.clientWidth / SIZE;
        const cellHeight = board.clientHeight / SIZE;
        const x1 = (from.c + 0.5) * cellWidth;
        const y1 = (from.r + 0.5) * cellHeight;
        const x2 = (to.c + 0.5) * cellWidth;
        const y2 = (to.r + 0.5) * cellHeight;

        const length = Math.hypot(x2 - x1, y2 - y1);

        const line = document.createElement("div");

        line.className = "laser-segment";
        line.style.left = `${x1}px`;
        line.style.top = `${y1}px`;
        line.style.width = `${length}px`;
        line.style.height = "2px";
        line.style.transform =
            `rotate(${Math.atan2(y2 - y1, x2 - x1)}rad)`;
        line.style.setProperty("--laser-color", color);

        board.appendChild(line);
        beamElements.push(line);

        toCell.classList.add("beam-trail");
    }

    function traceBeam() {
        clearTrace();

        if (won) return;

        tracing = true;
        fireBtn.disabled = true;
        fireBtn.textContent = "TRACING BEAM…";

        setStatus(
            "Tracing optical path",
            "Calculating reflections and checking the chamber.",
            "ready"
        );

        const result = calculatePath();
        let index = 0;

        function revealNext() {
            if (index >= result.points.length - 1) {
                tracing = false;

                fireBtn.disabled = false;
                fireBtn.innerHTML = `
                    <span class="play-symbol">▶</span>
                    POWER THE CELL
                    <span class="button-arrow">↗</span>
                `;

                finishTrace(result);
                return;
            }

            drawSegment(
                result.points[index],
                result.points[index + 1],
                result.segmentColors[index]
            );

            index++;

            traceTimer = setTimeout(revealNext, 65);
        }

        revealNext();
    }

    /* WIN / FAILURE STATES */

    function finishTrace(result) {
        if (result.outcome === "win") {
            const targetCell = cells.get(key(TARGET.r, TARGET.c));
            const battery = targetCell.querySelector(".battery");

            if (battery) battery.classList.add("powered");

            targetCell.classList.add("laser-hit");

            won = true;
            progressBar.style.width = "100%";

            setStatus(
                "Connection established",
                "Power cell energized. Optical path confirmed.",
                "success"
            );

            setTimeout(() => {
                winOverlay.classList.add("show");
                winOverlay.setAttribute("aria-hidden", "false");
            }, 350);

        } else if (result.outcome === "loop") {
            setStatus(
                "Reflection loop detected",
                "The beam is repeating its path. Rotate a mirror to break the loop.",
                "error"
            );

        } else if (result.outcome === "blocked") {
            setStatus(
                "Beam intercepted",
                "A fixed stone blocked the beam. Choose another mirror route.",
                "error"
            );

        } else {
            setStatus(
                "Target not reached",
                "The beam escaped the chamber. Redirect it toward the power cell.",
                "error"
            );
        }
    }

    function setStatus(title, message, kind) {
        statusTitle.textContent = title;
        statusMessage.textContent = message;

        statusCard.classList.remove("success", "error");

        if (kind === "success") {
            statusCard.classList.add("success");
        }

        if (kind === "error") {
            statusCard.classList.add("error");
        }
    }

    /* RESET THE PUZZLE */

    function resetGame() {
        clearTrace();

        mirrors.clear();
        won = false;

        winOverlay.classList.remove("show");
        winOverlay.setAttribute("aria-hidden", "true");

        progressBar.style.width = "12.5%";

        createBoard();

        setStatus(
            "System ready",
            "Place your first mirror to redirect the beam.",
            "ready"
        );
    }

    fireBtn.addEventListener("click", traceBeam);
    resetBtn.addEventListener("click", resetGame);
    continueBtn.addEventListener("click", resetGame);

    function updateBoardView() {
        const rotation = Number(rotationInput.value);
        const tilt = Number(tiltInput.value);
        const radians = rotation * Math.PI / 180;
        const tiltScale = Math.max(0.55, Math.cos(tilt * Math.PI / 180));
        const boardSize = board.offsetWidth;
        const availableWidth = Math.max(0, boardFrame.clientWidth - 24);
        const availableHeight = Math.max(0, boardFrame.clientHeight - 24);
        const rotatedExtent = Math.abs(Math.cos(radians)) +
            Math.abs(Math.sin(radians));
        const widthFactor = rotatedExtent;
        const heightFactor = rotatedExtent * tiltScale;
        const scale = Math.min(
            0.78,
            availableWidth / (boardSize * widthFactor),
            availableHeight / (boardSize * heightFactor)
        );

        board.style.setProperty("--board-rotation", `${rotation}deg`);
        board.style.setProperty("--board-tilt", `${tilt}deg`);
        board.style.setProperty("--board-tilt-scale", tiltScale);
        board.style.setProperty("--board-inverse-tilt", 1 / tiltScale);
        board.style.setProperty("--board-scale", scale);
        rotationValue.value = `${rotation}°`;
        rotationValue.textContent = `${rotation}°`;
        tiltValue.value = `${tilt}°`;
        tiltValue.textContent = `${tilt}°`;
    }

    rotationInput.addEventListener("input", updateBoardView);
    tiltInput.addEventListener("input", updateBoardView);
    window.addEventListener("resize", updateBoardView);
    resetViewBtn.addEventListener("click", () => {
        rotationInput.value = DEFAULT_ROTATION;
        tiltInput.value = DEFAULT_TILT;
        updateBoardView();
    });

    updateBoardView();
    createBoard();
})();