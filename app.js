import { CYFUR_CREDITS_PER_TOKEN, levels, claimLevelCompletion } from "./levels.js";
import { supabase, supabaseConfigured } from "./supabase.js";
import { GAME_API_BASE_URL } from "./supabase-config.js";
import {
    bytesToWalletBase64,
    clearPhantomMobileSession,
    connectPhantom,
    decodeWalletBytes,
    decryptPhantomMobileResponse,
    encodeWalletBytes,
    getConnectedPhantomWallet,
    getDepositPreparationFieldErrors,
    getFeePayerPreflightError,
    getPhantomProvider,
    getSolFundingStatus,
    isLinkedPhantomWallet,
    isMobileBrowser,
    readPhantomMobileCallback,
    rebuildMobileDepositAfterBlockhashRejection,
    savePhantomMobileSession,
    signAndBroadcastWithBlockhashRetry,
    setPhantomMobilePendingAction,
    startPhantomMobileConnect
} from "./wallet-provider.mjs";

const storageKey = "fluxgrid.player.v1";
const screens = [
    "video-screen",
    "name-screen",
    "home-screen",
    "leaderboard-screen",
    "profile-screen",
    "play-screen"
].map((id) => document.getElementById(id));
const introVideo = document.getElementById("intro-video");
const transitionVideo = document.getElementById("transition-video");
const videoScreen = document.getElementById("video-screen");
const videoAction = document.getElementById("video-action-button");
const videoSkip = document.getElementById("video-skip-button");
const rotateDevicePrompt = document.getElementById("rotate-device-prompt");
const videoCaption = document.getElementById("video-caption");
const backgroundMusic = document.getElementById("background-music");
const playerNameInput = document.getElementById("player-name");
document.getElementById("wallet-exchange-rate").textContent =
    `1 CYFUR = ${CYFUR_CREDITS_PER_TOKEN.toLocaleString("en-US")} CREDITS`;

function apiUrl(path) {
    if (!GAME_API_BASE_URL) return `/api/${path}`;
    let base;
    try {
        base = new URL(GAME_API_BASE_URL);
    } catch {
        throw new Error("GAME_API_BASE_URL must be an absolute HTTPS origin.");
    }
    if (base.protocol !== "https:" || base.username || base.password ||
        base.pathname !== "/" || base.search || base.hash) {
        throw new Error("GAME_API_BASE_URL must be an HTTPS origin without credentials, path, or query.");
    }
    return `${base.origin}/api/${path}`;
}

function readPlayer() {
    const saved = localStorage.getItem(storageKey);
    if (!saved) {
        return {
            name: "",
            playerId: "",
            watchedGameIntro: false,
            tutorialSeen: false,
            unlockedLevel: 1,
            completedLevels: [],
            lastLevel: 1
        };
    }

    try {
        const parsed = JSON.parse(saved);
        return {
            name: typeof parsed.name === "string" ? parsed.name : "",
            playerId: typeof parsed.playerId === "string" ? parsed.playerId : "",
            watchedGameIntro: parsed.watchedGameIntro === true,
            tutorialSeen: parsed.tutorialSeen === true,
            unlockedLevel: Math.min(99, Math.max(1, Number(parsed.unlockedLevel) || 1)),
            completedLevels: Array.isArray(parsed.completedLevels)
                ? [...new Set(parsed.completedLevels.filter((level) => Number.isInteger(level) && level >= 1 && level <= 99))]
                : [],
            lastLevel: Math.min(99, Math.max(1, Number(parsed.lastLevel) || 1))
        };
    } catch (error) {
        console.warn("Saved RelicGrid profile could not be read; starting a fresh local profile.", error);
        return {
            name: "",
            playerId: "",
            watchedGameIntro: false,
            tutorialSeen: false,
            unlockedLevel: 1,
            completedLevels: [],
            lastLevel: 1
        };
    }
}

let player = readPlayer();
let activeVideoPlayback = null;
let nextInterstitialAt = player.completedLevels.length + randomTransitionInterval();
let interstitialScheduleNeedsSync = true;
let interstitialClipIndex = Math.floor(Math.random() * 2);
let pendingLevel = null;
let activeWalletLevelSessionId = null;
let walletTimerStartPromise = Promise.resolve(false);
const processedLevelCompletions = new Set();
const pendingLevelEntryRequests = new Map();
let levelEntryRequestInProgress = false;
let musicStarted = false;
let authUser = null;
let backendStatus = supabaseConfigured ? "Connecting to Supabase…" : "Supabase is not configured.";
let backendReady;
let walletStatusSnapshot = null;
let solanaWeb3ModulePromise = null;
let levelsGloballyLocked = true;

function savePlayer() {
    localStorage.setItem(storageKey, JSON.stringify(player));
}

function randomTransitionInterval() {
    return 10 + Math.floor(Math.random() * 6);
}

function stopVideoPlayback(video) {
    if (activeVideoPlayback?.video !== video) return;
    activeVideoPlayback = null;
    rotateDevicePrompt.hidden = true;
    delete videoScreen.dataset.orientationBlocked;
}

function attemptActiveVideoPlayback() {
    const active = activeVideoPlayback;
    if (!active || videoOrientationQuery.matches) return;
    try {
        const playback = active.video.play();
        if (playback && typeof playback.catch === "function") {
            playback.catch((error) => {
                if (activeVideoPlayback !== active ||
                    (error.name === "AbortError" && active.video.paused)) return;
                active.onError(error);
            });
        }
    } catch (error) {
        active.onError(error);
    }
}

const videoOrientationQuery = window.matchMedia("(max-width: 900px) and (orientation: portrait)");

function updateVideoOrientation() {
    const active = activeVideoPlayback;
    if (!active) return;
    fitVideoFrame(active.video);
    if (videoOrientationQuery.matches) {
        active.video.pause();
        videoScreen.dataset.orientationBlocked = "true";
        rotateDevicePrompt.hidden = false;
        return;
    }
    rotateDevicePrompt.hidden = true;
    delete videoScreen.dataset.orientationBlocked;
    if (active.video.paused) attemptActiveVideoPlayback();
}

function playVideoInLandscape(video, onError) {
    activeVideoPlayback = { video, onError };
    updateVideoOrientation();
}

videoOrientationQuery.addEventListener("change", updateVideoOrientation);
window.addEventListener("resize", updateVideoOrientation);
window.screen.orientation?.addEventListener("change", updateVideoOrientation);

function nextUnlockedLevel(completedLevels) {
    const completed = new Set(completedLevels);
    let next = 1;
    while (completed.has(next) && next < 99) next++;
    return next;
}

function getContinueLevel() {
    return player.completedLevels.includes(player.lastLevel)
        ? player.unlockedLevel
        : Math.min(player.lastLevel, player.unlockedLevel);
}

async function refreshOwnProgress() {
    const { data, error } = await supabase
        .from("level_completions")
        .select("level_number")
        .eq("player_id", authUser.id);
    if (error) throw error;
    player.completedLevels = [...new Set(data.map((record) => record.level_number))].sort((a, b) => a - b);
    player.unlockedLevel = nextUnlockedLevel(player.completedLevels);
    if (interstitialScheduleNeedsSync) {
        nextInterstitialAt = player.completedLevels.length + randomTransitionInterval();
        interstitialScheduleNeedsSync = false;
    }
    savePlayer();
}

async function initializeBackend() {
    if (!supabaseConfigured) {
        renderProfile();
        return false;
    }

    try {
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        authUser = sessionData.session?.user ?? null;
        if (!authUser) {
            const { data, error } = await supabase.auth.signInAnonymously();
            if (error) throw error;
            authUser = data.user;
        }
        if (!authUser) throw new Error("Supabase did not return an authenticated player.");

        player.playerId = authUser.id;
        const { data: profile, error: profileError } = await supabase
            .from("player_profiles")
            .select("display_name")
            .eq("id", authUser.id)
            .maybeSingle();
        if (profileError) throw profileError;
        if (!profile) throw new Error("Player profile is missing. Run supabase-leaderboard.sql in the SQL Editor.");

        if (profile.display_name) {
            player.name = profile.display_name;
        } else if (player.name) {
            const { error } = await supabase.rpc("set_player_display_name", {
                p_display_name: player.name
            });
            if (error) throw error;
        }

        await refreshOwnProgress();
        backendStatus = "Connected to the RelicGrid leaderboard.";
        savePlayer();
        renderProfile();
        return true;
    } catch (error) {
        console.error("Supabase player initialization failed.", error);
        backendStatus = `Supabase connection failed: ${error.message}`;
        renderProfile();
        return false;
    }
}

function showScreen(id) {
    for (const screen of screens) screen.hidden = screen.id !== id;
}

function stopMusic() {
    backgroundMusic.pause();
    backgroundMusic.currentTime = 0;
    musicStarted = false;
}

function startMusic() {
    if (musicStarted && !backgroundMusic.paused) return;
    musicStarted = true;
    const playback = backgroundMusic.play();
    if (playback && typeof playback.catch === "function") {
        playback.catch((error) => {
            console.warn("Background music could not start.", error);
            musicStarted = false;
            const status = document.getElementById("game-status");
            if (status) status.textContent = "Music is unavailable in this browser; the puzzle is still playable.";
        });
    }
}

function renderProfile() {
    const completed = player.completedLevels.length;
    const name = player.name || "Pilot";
    document.getElementById("profile-name").textContent = name;
    document.getElementById("profile-initial").textContent = name.slice(0, 1).toUpperCase();
    document.getElementById("profile-progress").textContent = `${completed} / 99 cleared`;
    document.getElementById("campaign-progress").textContent =
        `${String(completed).padStart(2, "0")} / 99`;
    const progressFill = document.getElementById("campaign-progress-fill");
    if (progressFill) {
        progressFill.style.width = `${Math.min(100, completed / 99 * 100)}%`;
    }
    const nextLevel = levels[getContinueLevel() - 1];
    const nextLevelLabel = document.getElementById("hero-next-level");
    if (nextLevelLabel) {
        nextLevelLabel.textContent = nextLevel
            ? `LEVEL ${String(nextLevel.number).padStart(2, "0")} / 99`
            : "CAMPAIGN COMPLETE";
    }

    const profileDetails = document.getElementById("profile-details");
    profileDetails.replaceChildren(
        statCard("CALLSIGN", name),
        statCard("PLAYER ID", player.playerId || "Available after Supabase setup"),
        statCard("LEVELS COMPLETED", `${completed} / 99`),
        statCard("NEXT STORY LEVEL", `LEVEL ${String(player.unlockedLevel).padStart(2, "0")}`),
        statCard("LEADERBOARD", supabaseConfigured ? backendStatus : "Configure Supabase to enable shared rankings")
    );
}

function setLeaderboardStatus(message, state = "") {
    const status = document.getElementById("leaderboard-status");
    status.textContent = message;
    status.dataset.state = state;
}

function appendLeaderboardCell(row, text, className = "") {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = text;
    row.append(cell);
    return cell;
}

function renderLeaderboardPodium(records) {
    const podium = document.getElementById("leaderboard-podium");
    podium.replaceChildren();
    for (const [index, record] of records.slice(0, 3).entries()) {
        const rank = index + 1;
        const card = document.createElement("article");
        card.style.setProperty("--row-index", String(index));
        card.className = `podium-card podium-rank-${rank}${record.player_id === authUser.id ? " is-current-player" : ""}`;
        const crest = document.createElement("span");
        crest.className = "podium-crest";
        crest.textContent = String(rank).padStart(2, "0");
        const label = document.createElement("span");
        label.className = "podium-label";
        label.textContent = rank === 1 ? "SIGNAL ACE" : rank === 2 ? "GRID RUNNER" : "LIGHT SEEKER";
        const name = document.createElement("strong");
        name.className = "podium-name";
        name.textContent = record.display_name || "Pilot";
        const score = document.createElement("span");
        score.className = "podium-score";
        score.textContent = `${record.levels_completed} / 99 SECTORS`;
        const marker = document.createElement("span");
        marker.className = "podium-rank-mark";
        marker.textContent = rank === 1 ? "✦" : rank === 2 ? "◇" : "△";
        card.append(crest, label, name, score, marker);
        podium.append(card);
    }
}

async function refreshLeaderboard() {
    const rows = document.getElementById("leaderboard-rows");
    rows.replaceChildren();
    if (!supabaseConfigured) {
        setLeaderboardStatus("Add your Supabase project URL and publishable key in supabase-config.js to enable shared rankings.", "error");
        return;
    }

    setLeaderboardStatus("Loading saved player records…");
    let connected = await backendReady;
    if (!connected && supabaseConfigured) {
        backendReady = initializeBackend();
        connected = await backendReady;
    }
    if (!connected) {
        setLeaderboardStatus(backendStatus, "error");
        return;
    }

    const { data, error } = await supabase
        .from("fluxgrid_leaderboard")
        .select("rank,player_id,display_name,levels_completed,highest_level")
        .order("rank", { ascending: true })
        .limit(100);
    if (error) {
        console.error("Leaderboard records could not be loaded.", error);
        setLeaderboardStatus(`Could not load leaderboard: ${error.message}`, "error");
        return;
    }

    if (!data.length) {
        renderLeaderboardPodium([]);
        const row = document.createElement("tr");
        const cell = appendLeaderboardCell(row, "No pilots yet. Complete a level to appear here.", "leaderboard-empty");
        cell.colSpan = 4;
        rows.append(row);
        setLeaderboardStatus("Connected. No player records have been saved yet.");
        return;
    }

    renderLeaderboardPodium(data);
    for (const [index, record] of data.entries()) {
        const row = document.createElement("tr");
        row.style.setProperty("--row-index", String(index));
        if (record.player_id === authUser.id) row.classList.add("is-current-player");
        appendLeaderboardCell(row, `#${String(record.rank).padStart(2, "0")}`, "rank-cell");

        const playerCell = document.createElement("td");
        const identity = document.createElement("span");
        identity.className = "leaderboard-player";
        identity.textContent = record.display_name || "Pilot";
        if (record.player_id === authUser.id) {
            const badge = document.createElement("span");
            badge.className = "leaderboard-current";
            badge.textContent = "YOU";
            identity.append(badge);
        }
        const identifier = document.createElement("small");
        identifier.className = "leaderboard-player-id";
        identifier.textContent = record.player_id;
        playerCell.append(identity, identifier);
        row.append(playerCell);
        appendLeaderboardCell(row, `${record.levels_completed} / 99`, "leaderboard-score");
        appendLeaderboardCell(row, record.highest_level ? `LEVEL ${String(record.highest_level).padStart(2, "0")}` : "—");
        rows.append(row);
    }
    setLeaderboardStatus(`${data.length} player${data.length === 1 ? "" : "s"} loaded from Supabase.`);
}

function statCard(label, value) {
    const card = document.createElement("article");
    card.className = "stat-card";
    const heading = document.createElement("span");
    heading.className = "eyebrow";
    heading.textContent = label;
    const output = document.createElement("strong");
    output.textContent = value;
    card.append(heading, output);
    return card;
}

function applyLevelsLockState(locked, statusMessage = "") {
    const changed = levelsGloballyLocked !== locked;
    levelsGloballyLocked = locked;
    const continueButton = document.getElementById("continue-game");
    const lockBanner = document.getElementById("levels-lock-banner");
    const sectionDescription = document.getElementById("level-section-description");
    const nextLevelButton = document.getElementById("next-level");

    continueButton.disabled = locked;
    lockBanner.hidden = !locked;
    sectionDescription.textContent = locked
        ? "All 99 sectors are temporarily locked. Your campaign progress and saved records remain unchanged."
        : "Choose any sector and track campaign progress as you go.";
    if (nextLevelButton) nextLevelButton.disabled = locked || Number(nextLevelButton.dataset.nextLevel) > 99;

    if (locked) {
        setLevelEntryMessage(statusMessage ||
            "All 99 levels are temporarily locked. Your saved progress remains intact.", "disabled");
    } else {
        setLevelEntryMessage("Campaign access is open. Your saved progress remains intact.", "ready");
    }

    if (changed && document.getElementById("level-list")) renderLevels();

    if (locked && !document.getElementById("play-screen").hidden) {
        activeWalletLevelSessionId = null;
        pendingLevel = null;
        stopMusic();
        showScreen("home-screen");
    }
}

async function refreshLevelsLockState() {
    try {
        const response = await fetch(apiUrl("game-config"), { cache: "no-store" });
        if (!response.ok) throw new Error(`Campaign lock status unavailable (${response.status}).`);
        const config = await response.json();
        if (typeof config.levelsLocked !== "boolean") {
            throw new Error("Campaign lock status returned an invalid response.");
        }
        applyLevelsLockState(config.levelsLocked);
        return config.levelsLocked;
    } catch (error) {
        console.error("Campaign lock status could not be verified; levels remain locked.", error);
        applyLevelsLockState(true, "Campaign availability could not be verified. All 99 levels remain locked.");
        return true;
    }
}

function renderLevels() {
    const list = document.getElementById("level-list");
    const fragment = document.createDocumentFragment();
    const continueLevel = getContinueLevel();
    for (const level of levels) {
        const completed = player.completedLevels.includes(level.number);
        const current = level.number === continueLevel && !completed;
        const locked = levelsGloballyLocked;
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.style.setProperty("--card-index", String((level.number - 1) % 12));
        button.className = locked
            ? "level-card is-locked is-temporarily-locked"
            : `level-card is-unlocked${completed ? " is-complete" : ""}${current ? " is-current" : ""}`;
        button.type = "button";
        button.disabled = locked;
        button.dataset.level = String(level.number);

        const number = document.createElement("span");
        number.className = "level-number";
        number.textContent = String(level.number).padStart(2, "0");
        const detail = document.createElement("span");
        detail.className = "level-detail";
        const title = document.createElement("b");
        title.textContent = level.title;
        const meta = document.createElement("small");
        meta.textContent = `${level.par} MIRROR${level.par === 1 ? "" : "S"} REQUIRED · TIER ${level.band}`;
        const entryCost = document.createElement("small");
        entryCost.className = "level-cost";
        entryCost.textContent = locked ? "TEMPORARILY LOCKED" : "FREE PLAY";
        detail.append(title, meta);
        const badge = document.createElement("span");
        badge.className = "level-state";
        badge.textContent = locked ? "LOCKED" : completed ? "CLEARED" : current ? "NEXT UP" : "PLAY";
        const cost = document.createElement("span");
        cost.className = "level-entry-cost";
        cost.append(entryCost);
        button.append(number, detail, cost, badge);
        button.setAttribute("aria-label", locked
            ? `Level ${level.number}, temporarily locked`
            : `Play level ${level.number}, free play${completed ? ", completed" : ""}`);
        button.addEventListener("click", () => void startLevel(level.number));
        item.append(button);
        fragment.append(item);
    }
    list.replaceChildren(fragment);
}

function renderHome() {
    renderProfile();
    renderLevels();
    showScreen("home-screen");
    void refreshWallet();
}

function formatCredits(value) {
    if (typeof value !== "string" && typeof value !== "number") return "Unavailable";
    try {
        return BigInt(value).toLocaleString("en-US");
    } catch (error) {
        console.error("Wallet API returned an invalid credit balance.", error);
        return "Unavailable";
    }
}

function setLevelEntryMessage(message, state = "disabled") {
        const status = document.getElementById("level-entry-status");
        status.textContent = message;
        status.dataset.state = state;
    }

async function requestLevelEntry(levelNumber) {
        if (levelEntryRequestInProgress) return null;
        if (!supabaseConfigured || !supabase) {
            setLevelEntryMessage("Cannot start a paid mission: player authentication and wallet verification are unavailable.", "error");
            return null;
        }

        levelEntryRequestInProgress = true;
        setLevelEntryMessage("Checking campaign access and verified credits with the backend…", "pending");
        try {
            const { data, error } = await supabase.auth.getSession();
            if (error) throw error;
            const accessToken = data.session?.access_token;
            if (!accessToken) {
                setLevelEntryMessage("Sign in before starting a paid mission. No credits were checked or charged.", "error");
                return null;
            }
            const requestId = pendingLevelEntryRequests.get(levelNumber) ?? crypto.randomUUID();
            pendingLevelEntryRequests.set(levelNumber, requestId);

            const response = await fetch(apiUrl("level-entry"), {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ levelNumber, requestId }),
                cache: "no-store"
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok && response.status < 500) pendingLevelEntryRequests.delete(levelNumber);

            if (result.balanceVerified === true && /^\d+$/.test(String(result.balanceCredits))) {
                const balance = document.getElementById("wallet-balance");
                balance.textContent = formatCredits(result.balanceCredits);
                document.getElementById("wallet-balance-state").textContent = "CREDITS · BACKEND VERIFIED";
            }

            if (response.status === 402 && result.error === "insufficient_balance") {
                const balanceMessage = /^\d+$/.test(String(result.balanceCredits))
                    ? `Your verified balance is ${formatCredits(result.balanceCredits)}.`
                    : "Your balance changed while entry was reserved; refresh the wallet and try again.";
                const costMessage = /^\d+$/.test(String(result.entryCostCredits))
                    ? `Level ${levelNumber} requires ${formatCredits(result.entryCostCredits)} credits.`
                    : `Level ${levelNumber} could not be charged.`;
                setLevelEntryMessage(`Insufficient verified credits. ${costMessage} ${balanceMessage}`, "error");
                return null;
            }
            if (response.status === 403 && result.error === "level_locked") {
                setLevelEntryMessage(`This sector is campaign-locked. Complete the currently available level first.`, "error");
                return null;
            }
            if (response.status === 423 && result.error === "levels_locked") {
                applyLevelsLockState(true);
                return null;
            }
            if (result.error === "paid_gameplay_disabled") {
                setLevelEntryMessage(
                    `Level ${levelNumber} requires ${formatCredits(result.entryCostCredits)} credits, and the backend confirms your balance. Paid gameplay is still disabled, so this level cannot start.`,
                    "disabled"
                );
                return null;
            }
            if (result.error === "wallet_schema_not_installed") {
                setLevelEntryMessage("Cannot start a paid mission: apply supabase-wallet.sql and deploy the wallet API before balance checks are available.", "error");
                return null;
            }
            if (result.error === "verified_balance_unavailable") {
                setLevelEntryMessage("Cannot start a paid mission: the backend has no verified credit balance for this player.", "error");
                return null;
            }
            if (result.error === "wallet_api_not_configured") {
                setLevelEntryMessage("Cannot start a paid mission: server wallet credentials are not configured.", "error");
                return null;
            }
            if (result.error === "authentication_required") {
                setLevelEntryMessage("Cannot start a paid mission: the backend could not authenticate this player.", "error");
                return null;
            }
            if (response.status === 404 || response.status === 501) {
                setLevelEntryMessage("Cannot start a paid mission: this preview host does not run the Vercel balance-check API. No level was started.", "error");
                return null;
            }
            if (response.ok && result.allowed === true && result.balanceVerified === true &&
                typeof result.sessionId === "string") {
                pendingLevelEntryRequests.delete(levelNumber);
                return result;
            }

            throw new Error(result.error || `Level entry check failed (${response.status}).`);
        } catch (error) {
            console.error("Paid level entry check failed closed.", error);
            setLevelEntryMessage(`Cannot start a paid mission: backend balance verification failed. ${error.message}`, "error");
            return null;
        } finally {
            levelEntryRequestInProgress = false;
    }
}

function formatTokenAmount(rawAmount, decimals) {
    if (!/^\d+$/.test(String(rawAmount)) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
        return "Amount unavailable";
    }
    const digits = String(rawAmount).padStart(decimals + 1, "0");
    if (decimals === 0) return digits;
    const whole = digits.slice(0, -decimals);
    const fraction = digits.slice(-decimals).replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole;
}

function setWalletMessage(message, state = "") {
    const status = document.getElementById("wallet-api-status");
    status.textContent = message;
    status.dataset.state = state;
    const badge = document.getElementById("wallet-status-value");
    const stateLabels = {
        verifying: "VERIFYING",
        pending: "PENDING",
        confirmed: "CONFIRMED",
        rejected: "REJECTED",
        error: "ERROR",
        disabled: "DISABLED",
        ready: "READY"
    };
    if (badge && stateLabels[state]) {
        badge.textContent = stateLabels[state];
        badge.dataset.state = state;
    }
}

function showPhantomUnavailableMessage() {
    if (isMobileBrowser()) {
        if (window.location.protocol === "https:") {
            try {
                setWalletMessage("Opening Phantom's secure connection request. Approve wallet access; RelicGrid will return to this browser without sending tokens.", "pending");
                startPhantomMobileConnect(window, walletStatusSnapshot?.network);
            } catch (error) {
                setWalletMessage(`Phantom mobile connection could not start. ${error.message}`, "error");
            }
        } else {
            setWalletMessage("Phantom mobile connection requires the secure production HTTPS site.", "error");
        }
    } else {
        setWalletMessage("Phantom is not available to this page. Open RelicGrid in a normal Chrome or Edge tab where the Phantom extension is installed and allowed for this site—not an embedded preview—then reload. No transfer was made.", "error");
    }
}

function withWalletTimeout(promise, operation, timeoutMs = 30000) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => {
            reject(new Error(`${operation} timed out. Check that Phantom is unlocked and allowed to connect to this site, then retry.`));
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function renderWalletHistory(deposits) {
    const history = document.getElementById("wallet-history");
    if (!Array.isArray(deposits)) {
        history.replaceChildren();
        const empty = document.createElement("li");
        empty.className = "wallet-history-empty";
        empty.textContent = "Deposit history is unavailable.";
        history.append(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const deposit of deposits) {
        const item = document.createElement("li");
        item.className = "wallet-history-item";
        const detail = document.createElement("span");
        detail.className = "wallet-history-detail";
        const amount = document.createElement("b");
        amount.textContent = `${formatTokenAmount(deposit.amount_raw, deposit.token_decimals)} CYFUR`;
        const signature = document.createElement("small");
        signature.textContent = typeof deposit.transaction_signature === "string"
            ? `${deposit.transaction_signature.slice(0, 8)}…${deposit.transaction_signature.slice(-8)}`
            : "Transaction reference unavailable";
        detail.append(amount, signature);

        const state = document.createElement("span");
        state.className = "wallet-history-state";
        state.dataset.state = ["pending", "confirmed", "failed"].includes(deposit.status)
            ? deposit.status
            : "unknown";
        state.textContent = state.dataset.state.toUpperCase();
        item.append(detail, state);
        fragment.append(item);
    }
    if (!deposits.length) {
        const empty = document.createElement("li");
        empty.className = "wallet-history-empty";
        empty.textContent = "No verified deposits recorded.";
        fragment.append(empty);
    }
    history.replaceChildren(fragment);
}

function renderWithdrawalHistory(withdrawals) {
    const history = document.getElementById("withdrawal-history");
    if (!history) return;
    if (!Array.isArray(withdrawals)) {
        history.replaceChildren();
        const empty = document.createElement("li");
        empty.className = "wallet-history-empty";
        empty.textContent = "Withdrawal history is unavailable.";
        history.append(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const withdrawal of withdrawals) {
        const item = document.createElement("li");
        item.className = "wallet-history-item";
        const detail = document.createElement("span");
        detail.className = "wallet-history-detail";
        const amount = document.createElement("b");
        amount.textContent = `${formatTokenAmount((withdrawal.amount_raw ?? "0").toString(), Number(withdrawal.token_decimals ?? 8))} CYFUR`;
        const info = document.createElement("small");
        info.textContent = typeof withdrawal.transaction_signature === "string"
            ? `SIG ${withdrawal.transaction_signature.slice(0, 8)}…${withdrawal.transaction_signature.slice(-8)}`
            : `Status: ${withdrawal.status || "unknown"}`;
        detail.append(amount, info);

        const state = document.createElement("span");
        state.className = "wallet-history-state";
        const normalized = (withdrawal.status || "unknown").toLowerCase();
        state.dataset.state = ["pending", "confirmed", "failed"].includes(normalized) ? normalized : "unknown";
        state.textContent = state.dataset.state.toUpperCase();
        item.append(detail, state);
        fragment.append(item);
    }
    if (!withdrawals.length) {
        const empty = document.createElement("li");
        empty.className = "wallet-history-empty";
        empty.textContent = "No withdrawals recorded.";
        fragment.append(empty);
    }
    history.replaceChildren(fragment);
}

function setWithdrawalStatus(message, state = "") {
    const status = document.getElementById("withdrawal-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
}

function updateWithdrawalPreview() {
    const amountInput = document.getElementById("withdrawal-amount");
    const preview = document.getElementById("withdrawal-preview-amount");
    const decimals = Number(document.getElementById("withdrawal-token-decimals")?.dataset.decimals || 8);
    if (!amountInput || !preview) return;
    const value = (amountInput.value || "").trim();
    if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
        preview.textContent = "0.00000000 CYFUR";
        return;
    }
    const credits = BigInt(value);
    const rawAmount = (credits * 10n ** BigInt(decimals)) / 10000n;
    preview.textContent = `${formatTokenAmount(rawAmount.toString(), decimals)} CYFUR`;
}

async function refreshWithdrawalStatus() {
    const addressInput = document.getElementById("withdrawal-wallet-address");
    const submit = document.getElementById("withdrawal-submit");
    const validateButton = document.getElementById("withdrawal-validate-address");
    const amountInput = document.getElementById("withdrawal-amount");
    const balanceValue = document.getElementById("withdrawal-eligible-balance");
    const balanceNote = document.getElementById("withdrawal-balance-note");
    const minimumValue = document.getElementById("withdrawal-minimum");
    const minimumNote = document.getElementById("withdrawal-minimum-note");
    const history = document.getElementById("withdrawal-history");
    const tokenDecimals = document.getElementById("withdrawal-token-decimals");
    if (!addressInput || !submit || !validateButton || !amountInput || !balanceValue || !balanceNote || !minimumValue || !minimumNote || !history) return;
    setWithdrawalStatus("Loading withdrawal details…", "pending");
    submit.disabled = true;
    validateButton.disabled = true;
    amountInput.disabled = true;
    addressInput.disabled = true;
    minimumValue.textContent = "Not configured";
    minimumNote.textContent = "No minimum withdrawal rule is defined in the approved project rules.";
    balanceValue.textContent = "0 CREDITS";
    balanceNote.textContent = "No active withdrawal balance loaded yet.";
    history.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "wallet-history-empty";
    empty.textContent = "No withdrawals recorded.";
    history.append(empty);

    try {
        if (!supabaseConfigured || !supabase) {
            setWithdrawalStatus("Sign in to your game account before requesting a CYFUR withdrawal.", "error");
            return;
        }
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        const accessToken = data.session?.access_token;
        if (!accessToken) {
            setWithdrawalStatus("Sign in to your RelicGrid account before requesting a CYFUR withdrawal.", "error");
            return;
        }
        const response = await fetch(apiUrl("withdrawals"), {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            cache: "no-store"
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = result.message || result.error || `Withdrawal status could not be loaded (${response.status}).`;
            setWithdrawalStatus(message, "error");
            return;
        }
        const availableCredits = BigInt(result.availableCredits || "0");
        const totalCredits = BigInt(result.balanceCredits || "0");
        const decimals = Number(result.config?.tokenDecimals ?? 8);
        if (tokenDecimals) tokenDecimals.dataset.decimals = String(decimals);
        if (typeof result.walletAddress === "string" && result.walletAddress.trim() && !addressInput.value.trim()) {
            addressInput.value = result.walletAddress.trim();
        }
        balanceValue.textContent = `${formatCredits(result.availableCredits || "0")} CREDITS`;
        balanceNote.textContent = `${formatCredits(result.balanceCredits || "0")} total credits on file · ${formatCredits(result.availableCredits || "0")} eligible for withdrawal`;
        minimumValue.textContent = "Not configured";
        minimumNote.textContent = "No minimum withdrawal rule is defined in the approved project rules.";
        renderWithdrawalHistory(result.withdrawals || []);
        const ready = result.withdrawalEnabled === true && typeof result.walletAddress === "string" && result.walletAddress.trim();
        submit.disabled = !ready || availableCredits <= 0n || !amountInput.value.trim();
        validateButton.disabled = !ready;
        amountInput.disabled = !ready;
        addressInput.disabled = !ready;
        if (!ready) {
            setWithdrawalStatus("Real withdrawals remain disabled until the treasury signer, approved CYFUR mint, and owner authorization are verified.", "error");
            return;
        }
        if (amountInput.value.trim() === "") {
            amountInput.value = availableCredits > 0n ? availableCredits.toString() : "0";
        }
        updateWithdrawalPreview();
        setWithdrawalStatus("Withdrawal requests are enabled. Review the linked wallet and send the request only after confirming the destination is correct.", "ready");
    } catch (error) {
        console.error("Withdrawal status failed to load.", error);
        setWithdrawalStatus(error.message || "Withdrawal details could not be loaded.", "error");
    }
}

async function submitWithdrawalRequest(event) {
    event.preventDefault();
    const form = document.getElementById("withdrawal-form");
    const addressInput = document.getElementById("withdrawal-wallet-address");
    const amountInput = document.getElementById("withdrawal-amount");
    const submitButton = document.getElementById("withdrawal-submit");
    const statusNode = document.getElementById("withdrawal-transaction-status");
    if (!form || !addressInput || !amountInput || !submitButton) return;
    const walletAddress = (addressInput.value || "").trim();
    const amountCredits = (amountInput.value || "").trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
        setWithdrawalStatus("Enter a valid Solana wallet address that matches the verified linked wallet for this account.", "error");
        return;
    }
    if (!/^\d+$/.test(amountCredits) || BigInt(amountCredits) <= 0n) {
        setWithdrawalStatus("Enter a valid positive credit amount to withdraw.", "error");
        return;
    }
    submitButton.disabled = true;
    setWithdrawalStatus("Submitting withdrawal request to the secure server…", "pending");
    if (statusNode) {
        statusNode.hidden = false;
        statusNode.textContent = "Requesting the on-chain transfer…";
        statusNode.dataset.state = "pending";
    }

    try {
        if (!supabaseConfigured || !supabase) throw new Error("Supabase authentication is unavailable.");
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        const accessToken = data.session?.access_token;
        if (!accessToken) throw new Error("Sign in to your RelicGrid account before requesting a CYFUR withdrawal.");
        const response = await fetch(apiUrl("withdrawals"), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ action: "submit", amountCredits }),
            cache: "no-store"
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            const errorMessage = result.message || result.error || `Withdrawal request failed (${response.status}).`;
            setWithdrawalStatus(errorMessage, "error");
            if (statusNode) {
                statusNode.textContent = errorMessage;
                statusNode.dataset.state = "error";
            }
            return;
        }
        if (result.status === "confirmed") {
            setWithdrawalStatus(`Withdrawal confirmed. Signature: ${result.signature || "pending verification"}`, "ready");
            if (statusNode) {
                statusNode.textContent = `Transaction signature: ${result.signature || "unavailable"}`;
                statusNode.dataset.state = "ready";
            }
            await refreshWithdrawalStatus();
            return;
        }
        setWithdrawalStatus(result.message || "The server accepted the request but the final transfer status is pending.", "pending");
        if (statusNode) {
            statusNode.textContent = result.message || "Withdrawal is pending verification.";
            statusNode.dataset.state = "pending";
        }
        await refreshWithdrawalStatus();
    } catch (error) {
        console.error("Withdrawal submission failed.", error);
        setWithdrawalStatus(error.message || "The withdrawal request could not be completed.", "error");
        if (statusNode) {
            statusNode.textContent = error.message || "Withdrawal failed.";
            statusNode.dataset.state = "error";
        }
    } finally {
        submitButton.disabled = false;
    }
}

async function validateWithdrawalAddress() {
    const addressInput = document.getElementById("withdrawal-wallet-address");
    const status = document.getElementById("withdrawal-status");
    if (!addressInput || !status) return;
    const value = (addressInput.value || "").trim();
    if (!value) {
        setWithdrawalStatus("Enter the Solana wallet address that should receive CYFUR.", "error");
        return;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
        setWithdrawalStatus("This is not a valid Solana public key. Check the address and try again.", "error");
        return;
    }
    setWithdrawalStatus("This wallet address looks valid and matches the expected Solana format.", "ready");
}

async function refreshWallet() {
    const address = document.getElementById("wallet-address");
    const copyButton = document.getElementById("wallet-copy-address");
    const signatureInput = document.getElementById("deposit-signature");
    const signatureSubmit = document.getElementById("deposit-verify-button");
    const balance = document.getElementById("wallet-balance");
    const status = document.getElementById("wallet-status-value");
    const refreshButton = document.getElementById("wallet-refresh");
    const balanceRefreshButton = document.getElementById("wallet-balance-refresh");
    const memoCopyButton = document.getElementById("wallet-copy-memo");
    const paymentMemo = document.getElementById("deposit-required-memo");
    walletStatusSnapshot = null;
    refreshButton.disabled = true;
    refreshButton.textContent = "LOADING";
    balanceRefreshButton.disabled = true;
    balanceRefreshButton.textContent = "CHECKING BALANCE…";
    copyButton.disabled = true;
    address.textContent = "Loading verified treasury…";
    status.textContent = "DISABLED";
    status.dataset.state = "disabled";
    balance.textContent = "Unavailable";
    document.getElementById("wallet-balance-state").textContent = "CREDITS · NOT VERIFIED";
    paymentMemo.textContent = "Checking deposit readiness…";
    signatureInput.disabled = true;
    memoCopyButton.disabled = true;
    signatureSubmit.disabled = true;
    renderWalletHistory(null);

    try {
        if (!supabaseConfigured || !supabase) {
            paymentMemo.textContent = "Unavailable: Supabase is not configured.";
            setWalletMessage("Supabase is not configured; wallet data is unavailable and deposits remain disabled.", "error");
            return;
        }
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        const accessToken = data.session?.access_token;
        if (!accessToken) {
            paymentMemo.textContent = "Unavailable: sign in to your RelicGrid account first.";
            setWalletMessage("Sign in to view wallet data. Deposits remain disabled.", "error");
            return;
        }

        const response = await fetch(apiUrl("wallet"), {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: "no-store"
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (result.error === "wallet_schema_not_installed") {
                paymentMemo.textContent = "Deposits are temporarily unavailable.";
                setWalletMessage("Deposits are temporarily unavailable. Please check back later.", "disabled");
                return;
            }
            if (result.error === "wallet_api_not_configured") {
                paymentMemo.textContent = "Deposits are temporarily unavailable.";
                setWalletMessage("Deposits are temporarily unavailable. Please check back later.", "disabled");
                return;
            }
            if (result.error === "authentication_required") {
                paymentMemo.textContent = "Unavailable: your session could not be authenticated.";
                setWalletMessage("Your RelicGrid identity could not be authenticated by the wallet API.", "error");
                return;
            }
            if (response.status === 404 || response.status === 501) {
                paymentMemo.textContent = "Deposits are temporarily unavailable.";
                setWalletMessage("Deposits are temporarily unavailable. Please check back later.", "disabled");
                return;
            }
            if (response.status >= 500) {
                throw new Error("Deposits are temporarily unavailable. Please try again later.");
            }
            throw new Error(result.error || `Wallet request failed (${response.status}).`);
        }

        address.textContent = result.treasuryAddress || "Treasury unavailable";
        copyButton.disabled = !result.treasuryAddress;
        walletStatusSnapshot = result;
        const depositReady = result.depositsEnabled === true &&
            Boolean(result.treasuryAddress) &&
            Boolean(result.officialMintAddress) &&
            Boolean(result.tokenProgramId) &&
            Number.isInteger(result.tokenDecimals) &&
            Boolean(result.treasuryTokenAccountAddress);
        signatureInput.disabled = !depositReady;
        signatureSubmit.disabled = !depositReady;
        balance.textContent = result.balanceCredits === null
            ? "Unavailable"
            : formatCredits(result.balanceCredits);
        document.getElementById("wallet-balance-state").textContent =
            result.balanceVerified === true ? "CREDITS · BACKEND VERIFIED" : "CREDITS · NOT VERIFIED";
        status.textContent = result.depositsEnabled === true
            ? `READY${result.network ? ` · ${result.network.toUpperCase()}` : ""}`
            : "DISABLED";
        renderWalletHistory(result.deposits);
        if (depositReady) {
            await createCyfurDepositInstructions();
        } else {
            const readinessMessage = typeof result.disabledMessage === "string" &&
                result.disabledMessage.trim()
                ? result.disabledMessage
                : "Deposits are temporarily unavailable. Please check back later.";
            paymentMemo.textContent = `Unavailable: ${readinessMessage}`;
            setWalletMessage(readinessMessage, "disabled");
        }
        await refreshWithdrawalStatus();
    } catch (error) {
        console.error("Wallet data could not be refreshed.", error);
        paymentMemo.textContent = "Deposits are temporarily unavailable.";
        setWalletMessage("Deposits are temporarily unavailable. Please try again later.", "disabled");
    } finally {
        refreshButton.disabled = false;
        refreshButton.textContent = "REFRESH";
        balanceRefreshButton.disabled = false;
        balanceRefreshButton.textContent = "REFRESH BALANCE";
    }

}

function parseTokenAmount(amountText, decimals) {
    const value = amountText.trim();
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 ||
        !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
        throw new Error("Enter a valid positive CYFUR amount.");
    }
    const [whole, fraction = ""] = value.split(".");
    if (fraction.length > decimals) {
        throw new Error(`This CYFUR mint supports at most ${decimals} decimal places.`);
    }
    const scale = 10n ** BigInt(decimals);
    const rawAmount = BigInt(whole) * scale +
        BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
    if (rawAmount <= 0n || rawAmount * BigInt(CYFUR_CREDITS_PER_TOKEN) / scale <= 0n) {
        throw new Error("This amount converts to less than 1 credit and will not be accepted.");
    }
    if (rawAmount > 18446744073709551615n) {
        throw new Error("This amount is too large for a single Solana token transfer.");
    }
    return rawAmount;
}

async function loadSolanaWeb3() {
    if (!solanaWeb3ModulePromise) {
        solanaWeb3ModulePromise = import("https://esm.sh/@solana/web3.js@1.98.4?bundle");
    }
    return solanaWeb3ModulePromise;
}

function getAssociatedTokenAddress(PublicKey, owner, mint, tokenProgramId) {
    const associatedTokenProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
        associatedTokenProgram
    )[0];
}

function createAssociatedTokenAccountInstruction(
    TransactionInstruction,
    PublicKey,
    payer,
    associatedToken,
    owner,
    mint,
    tokenProgramId
) {
    return new TransactionInstruction({
        programId: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: associatedToken, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
            { pubkey: tokenProgramId, isSigner: false, isWritable: false }
        ],
        data: Uint8Array.of(1)
    });
}

function buildCyfurDepositTransaction({
    preparation,
    config,
    payer,
    rawAmount,
    paymentIntentMemo,
    PublicKey,
    Transaction,
    TransactionInstruction
}) {
    const invalidFields = getDepositPreparationFieldErrors(preparation);
    if (invalidFields.length > 0) {
        console.error("Deposit preparation response validation failed.", { invalidFields });
        throw new Error("The server returned invalid or incomplete transaction preparation.");
    }
    const mint = new PublicKey(config.officialMintAddress);
    const tokenProgramId = new PublicKey(config.tokenProgramId);
    const treasury = new PublicKey(config.treasuryAddress);
    const senderTokenAccount = getAssociatedTokenAddress(PublicKey, payer, mint, tokenProgramId);
    const treasuryTokenAccount = getAssociatedTokenAddress(PublicKey, treasury, mint, tokenProgramId);
    const instructions = [];
    if (!preparation.senderTokenAccounts.includes(senderTokenAccount.toString())) {
        instructions.push(createAssociatedTokenAccountInstruction(
            TransactionInstruction,
            PublicKey,
            payer,
            senderTokenAccount,
            payer,
            mint,
            tokenProgramId
        ));
    }
    if (!preparation.treasuryTokenAccounts.includes(treasuryTokenAccount.toString())) {
        instructions.push(createAssociatedTokenAccountInstruction(
            TransactionInstruction,
            PublicKey,
            payer,
            treasuryTokenAccount,
            treasury,
            mint,
            tokenProgramId
        ));
    }
    const transferData = new Uint8Array(10);
    transferData[0] = 12;
    for (let index = 0; index < 8; index += 1) {
        transferData[index + 1] = Number((rawAmount >> BigInt(index * 8)) & 0xffn);
    }
    transferData[9] = config.tokenDecimals;
    instructions.push(new TransactionInstruction({
        programId: tokenProgramId,
        keys: [
            { pubkey: senderTokenAccount, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true },
            { pubkey: payer, isSigner: true, isWritable: false }
        ],
        data: transferData
    }));
    instructions.push(new TransactionInstruction({
        programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
        data: new TextEncoder().encode(paymentIntentMemo)
    }));
    return new Transaction({
        feePayer: payer,
        recentBlockhash: preparation.blockhash
    }).add(...instructions);
}

function formatLamportsAsSol(lamports) {
    if (!Number.isSafeInteger(lamports) || lamports < 0) return "unavailable";
    const value = BigInt(lamports);
    const whole = value / 1_000_000_000n;
    const fraction = (value % 1_000_000_000n).toString().padStart(9, "0");
    return `${whole}.${fraction}`.replace(/\.?0+$/, "");
}

function formatRawTokenAmount(amountRaw, decimals) {
    if (typeof amountRaw !== "string" || !/^\d+$/.test(amountRaw)) return "unavailable";
    const scale = 10n ** BigInt(decimals);
    const value = BigInt(amountRaw);
    const whole = value / scale;
    const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
}

function renderFundingDiagnostic(result, tokenDecimals) {
    const sourceAmountCoverage = result.sourceTokenAmountCoversTransfer === null
        ? "unknown"
        : result.sourceTokenAmountCoversTransfer ? "yes" : "no";
    const lines = [
        `SOL balance: ${formatLamportsAsSol(result.payerLamports)} SOL`,
        `Estimated transaction fee: ${formatLamportsAsSol(result.transactionFeeLamports)} SOL`,
        `Fee payer account: ${result.feePayerAccountExists ? "exists" : "missing"}; owner program: ${result.feePayerOwnerProgram || "unknown"}; system-owned: ${result.feePayerSystemProgramOwned === null ? "unknown" : result.feePayerSystemProgramOwned ? "yes" : "no"}`,
        `Fee payer matches connected Phantom: ${result.feePayerKeyMatchesConnectedPhantom === null ? "unknown" : result.feePayerKeyMatchesConnectedPhantom ? "yes" : "no"}`,
        `Fee payer matches linked wallet: ${result.feePayerKeyMatchesLinkedWallet === null ? "unknown" : result.feePayerKeyMatchesLinkedWallet ? "yes" : "no"}`,
        `Balance query matches fee payer: ${result.payerBalanceQueryMatchesFeePayer === null ? "unknown" : result.payerBalanceQueryMatchesFeePayer ? "yes" : "no"}`,
        `Source CYFUR account: ${result.sourceTokenAccountExists ? "exists" : "missing"}; balance ${formatRawTokenAmount(result.sourceTokenAmountRaw, tokenDecimals)} CYFUR; enough for transfer: ${sourceAmountCoverage}`,
        `Source account checks — wallet owner: ${result.sourceTokenAccountOwnerMatchesPayer ? "yes" : "no"}; CYFUR mint: ${result.sourceTokenAccountMintMatchesConfiguredMint ? "yes" : "no"}; token program: ${result.sourceTokenAccountProgramMatchesConfig ? "yes" : "no"}`,
        `Treasury CYFUR account: ${result.treasuryTokenAccountExists ? "exists" : "missing"}`,
        `Treasury account checks — treasury owner: ${result.treasuryTokenAccountOwnerMatchesTreasury ? "yes" : "no"}; CYFUR mint: ${result.treasuryTokenAccountMintMatchesConfiguredMint ? "yes" : "no"}; token program: ${result.treasuryTokenAccountProgramMatchesConfig ? "yes" : "no"}`,
        `ATA rent-exempt minimum: ${formatLamportsAsSol(result.tokenAccountRentLamports)} SOL per account`,
        `Required ATA rent: ${formatLamportsAsSol(result.requiredRentLamports)} SOL`,
        `Fee plus required rent: ${formatLamportsAsSol(result.requiredTotalLamports)} SOL`,
        `Wallet covers fee plus required rent: ${result.payerBalanceCoversFeeAndRent === null ? "unknown" : result.payerBalanceCoversFeeAndRent ? "yes" : "no"}`,
        `Simulation: ${result.simulationPassed ? "passed" : "failed"}`,
        `Failing instruction: ${result.failedInstructionIndex === null ? "none identified" : `#${result.failedInstructionIndex} (${result.failedInstructionRole || "unknown"})`}`,
        `Failed instruction/program error: ${result.simulationError || "none"}`
    ];
    if (Array.isArray(result.simulationLogs) && result.simulationLogs.length > 0) {
        lines.push("Sanitized simulation logs:", ...result.simulationLogs);
    }
    if (Number.isSafeInteger(result.simulationUnitsConsumed)) {
        lines.push(`Compute units: ${result.simulationUnitsConsumed}`);
    }
    return lines.join("\n");
}

async function diagnoseCyfurDeposit() {
    const output = document.getElementById("wallet-preflight-results");
    const button = document.getElementById("wallet-preflight-button");
    const amountInput = document.getElementById("wallet-transfer-amount");
    const config = walletStatusSnapshot;
    try {
        if (!config?.linkedWalletAddress || !config.officialMintAddress ||
            !config.tokenProgramId || !Number.isInteger(config.tokenDecimals)) {
            throw new Error("The server has not provided the linked wallet and CYFUR configuration needed for a diagnostic.");
        }
        const connectedWallet = getConnectedPhantomWallet(window);
        if (!isLinkedPhantomWallet(connectedWallet, config.linkedWalletAddress)) {
            throw new Error("Connect Phantom to the wallet linked to this game account before running the read-only diagnostic.");
        }
        const rawAmount = parseTokenAmount(amountInput.value, config.tokenDecimals);
        const { PublicKey, Transaction, TransactionInstruction } =
            await loadSolanaWeb3();
        const result = await requestCyfurFundingDiagnostic({
            config,
            payer: new PublicKey(config.linkedWalletAddress),
            connectedWalletPublicKey: connectedWallet.publicKey,
            rawAmount,
            PublicKey,
            Transaction,
            TransactionInstruction
        });
        output.textContent = renderFundingDiagnostic(result, config.tokenDecimals);
        output.hidden = false;
    } catch (error) {
        output.textContent = `Read-only diagnostic could not complete: ${error.message}`;
        output.hidden = false;
    } finally {
        button.disabled = !walletStatusSnapshot?.linkedWalletAddress ||
            !walletStatusSnapshot?.officialMintAddress ||
            !walletStatusSnapshot?.tokenProgramId ||
            !Number.isInteger(walletStatusSnapshot?.tokenDecimals) ||
            !walletStatusSnapshot?.network;
    }
}

async function requestCyfurFundingDiagnostic({
    config,
    payer,
    connectedWalletPublicKey,
    rawAmount,
    PublicKey,
    Transaction,
    TransactionInstruction
}) {
    const preparation = await requestDepositTransaction("prepare-diagnostic");
    const diagnosticMemo = "RelicGrid payment intent: 00000000-0000-4000-8000-000000000000";
    const transaction = buildCyfurDepositTransaction({
        preparation,
        config,
        payer,
        rawAmount,
        paymentIntentMemo: diagnosticMemo,
        PublicKey,
        Transaction,
        TransactionInstruction
    });
    const transactionBytes = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false
    });
    const connectedWallet = getConnectedPhantomWallet(window);
    return requestDepositTransaction("diagnose", {
        amountRaw: rawAmount.toString(),
        transaction: bytesToWalletBase64(transactionBytes),
        connectedWalletPublicKey
    });
}

function getFundingPreflightError(diagnostic) {
    const feePayerError = getFeePayerPreflightError(diagnostic);
    if (feePayerError) {
        return new Error(`${feePayerError} No transaction approval was requested.`);
    }
    const status = getSolFundingStatus(diagnostic);
    if (status.status === "insufficient") {
        const requirement = diagnostic.requiredRentLamports > 0
            ? "create the missing CYFUR token account and pay the transaction fee"
            : "pay the transaction fee";
        return new Error(
            `Not enough SOL to ${requirement}. ` +
            `Balance: ${formatLamportsAsSol(status.balanceLamports)} SOL; ` +
            `estimated requirement: ${formatLamportsAsSol(status.requiredLamports)} SOL ` +
            `(${formatLamportsAsSol(diagnostic.requiredRentLamports)} SOL ATA rent + ` +
            `${formatLamportsAsSol(diagnostic.transactionFeeLamports)} SOL fee); ` +
            `short by ${formatLamportsAsSol(status.shortfallLamports)} SOL. ` +
            `No Phantom transaction approval was requested.`
        );
    }
    if (status.status !== "sufficient") {
        return new Error("Could not verify the wallet SOL balance, ATA rent, and transaction fee. No Phantom transaction approval was requested.");
    }
    if (diagnostic.simulationPassed !== true) {
        const failedInstruction = diagnostic.failedInstructionIndex === null
            ? ""
            : ` Instruction #${diagnostic.failedInstructionIndex} (${diagnostic.failedInstructionRole || "unknown"}) failed.`;
        return new Error(
            `The read-only Solana simulation did not pass.${failedInstruction} ` +
            `${diagnostic.simulationError || "Review the diagnostic output for details."} ` +
            "No Phantom transaction approval was requested."
        );
    }
    return null;
}

async function createCyfurDepositInstructions() {
    const config = walletStatusSnapshot;
    if (!config?.treasuryAddress || !config.officialMintAddress ||
        !config.treasuryTokenAccountAddress ||
        !config.tokenProgramId || !Number.isInteger(config.tokenDecimals) ||
        config.depositsEnabled !== true) {
        document.getElementById("deposit-required-memo").textContent =
            "Deposits are temporarily unavailable.";
        setWalletMessage("Deposits are temporarily unavailable. Please check back later.", "disabled");
        return;
    }
    const signatureInput = document.getElementById("deposit-signature");
    const verifyButton = document.getElementById("deposit-verify-button");
    const memoElement = document.getElementById("deposit-required-memo");
    signatureInput.disabled = true;
    verifyButton.disabled = true;
    memoElement.textContent = "Generating your secure payment reference…";
    setWalletMessage("Preparing your secure, player-specific payment reference…", "verifying");
    let intent = null;
    const storedIntentId = sessionStorage.getItem("relicgrid.payment-intent.v1");
    if (storedIntentId) {
        try {
            intent = await requestExistingPaymentIntent(storedIntentId);
        } catch (error) {
            sessionStorage.removeItem("relicgrid.payment-intent.v1");
            console.info("The previous payment reference is no longer active.", error.message);
        }
    }
    if (!intent) {
        intent = await requestPaymentIntent();
        sessionStorage.setItem("relicgrid.payment-intent.v1", intent.intentId);
    }
    if (intent.treasuryAddress !== config.treasuryAddress ||
        intent.treasuryTokenAccount !== config.treasuryTokenAccountAddress ||
        intent.mintAddress !== config.officialMintAddress ||
        intent.tokenProgramId !== config.tokenProgramId) {
        throw new Error("The payment reference does not match the verified treasury configuration.");
    }
    memoElement.textContent = intent.memo;
    document.getElementById("wallet-copy-memo").disabled = false;
    signatureInput.disabled = false;
    verifyButton.disabled = false;
    setWalletMessage("Ready. Send at least 1 CYFUR with this memo, then submit your transaction signature.", "ready");
}

async function requestPaymentIntent() {
    const response = await fetchWithTimeout(apiUrl("payment-intent"), {
        method: "POST",
        headers: await getWalletAuthorizationHeaders(),
        body: JSON.stringify({}),
        cache: "no-store"
    }, "Payment reference generation");
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (result.error === "payment_intent_migration_required") {
            throw new Error("Deposits are temporarily unavailable. Please check back later.");
        }
        if (response.status >= 500) {
            throw new Error("Deposits are temporarily unavailable. Please check back later.");
        }
        throw new Error("A payment reference could not be created. Please try again later.");
    }
    if (typeof result.intentId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.intentId) ||
        typeof result.memo !== "string" ||
        typeof result.treasuryTokenAccount !== "string" ||
        !/^[1-9]\d*$/.test(String(result.amountRaw)) ||
        !Number.isFinite(Date.parse(result.expiresAt)) ||
        Date.parse(result.expiresAt) <= Date.now()) {
        throw new Error("The server returned an invalid or expired payment intent.");
    }
    return result;
}

async function requestExistingPaymentIntent(paymentIntentId) {
    const response = await fetchWithTimeout(apiUrl("payment-intent"), {
        method: "POST",
        headers: await getWalletAuthorizationHeaders(),
        body: JSON.stringify({ action: "validate", paymentIntentId }),
        cache: "no-store"
    }, "Payment reference check");
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.message || result.error || `Payment intent validation failed (${response.status}).`);
    }
    if (result.intentId !== paymentIntentId ||
        typeof result.amountRaw !== "string" ||
        !/^[1-9]\d*$/.test(result.amountRaw) ||
        !Number.isFinite(Date.parse(result.expiresAt)) ||
        Date.parse(result.expiresAt) <= Date.now()) {
        throw new Error("The server returned an invalid or expired payment intent.");
    }
    return result;
}

async function fetchWithTimeout(url, options, operation, timeoutMs = 20000) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error(`${operation} timed out. Check your connection and retry.`);
        }
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

async function connectSolanaWallet() {
    if (!supabaseConfigured || !supabase) {
        setWalletMessage("Supabase authentication is unavailable. No wallet was linked.", "error");
        return;
    }
    if (!getPhantomProvider(window)) {
        showPhantomUnavailableMessage();
        return;
    }
    const walletConnectionPromise = withWalletTimeout(
        connectPhantom(window),
        "Phantom connection approval"
    );
    const button = document.getElementById("fund-account-button");
    if (!button) throw new Error("Wallet linking is not available in the deposit flow.");
    button.disabled = true;
    button.textContent = "CONNECTING WALLET…";
    try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        const accessToken = data.session?.access_token;
        if (!accessToken) throw new Error("Sign in before linking a Solana wallet.");
        setWalletMessage("Waiting for Phantom connection approval. No token transfer will happen.", "pending");
        const walletConnection = await walletConnectionPromise;
        if (!walletConnection) {
            showPhantomUnavailableMessage();
            return;
        }
        const { provider: walletProvider, publicKey: walletAddress } = walletConnection;
        if (typeof walletProvider.signMessage !== "function") {
            throw new Error("The connected Phantom provider cannot sign the wallet ownership proof.");
        }
        if (walletStatusSnapshot?.linkedWalletAddress === walletAddress) {
            setWalletMessage("Phantom is connected and its address matches the wallet linked to this authenticated game account.", "ready");
            return;
        }
        button.textContent = "VERIFYING WALLET…";
        setWalletMessage("Wallet connected. Requesting an ownership challenge from the server; this signature does not transfer tokens.", "pending");
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        };
        const challengeResponse = await fetch(apiUrl("wallet-link"), {
            method: "POST",
            headers,
            body: JSON.stringify({ action: "challenge", walletAddress }),
            cache: "no-store"
        });
        const challengeResult = await challengeResponse.json().catch(() => ({}));
        if (!challengeResponse.ok || typeof challengeResult.challenge !== "string") {
            throw new Error(challengeResult.message || challengeResult.error || `Wallet proof request failed (${challengeResponse.status}).`);
        }
        button.textContent = "SIGN IN PHANTOM…";
        setWalletMessage("Approve the RelicGrid ownership message in Phantom. It proves wallet ownership and does not send tokens or pay a network fee.", "pending");
        const signed = await withWalletTimeout(walletProvider.signMessage(
            new TextEncoder().encode(challengeResult.challenge),
            "utf8"
        ), "Phantom ownership signature");
        if (!signed?.signature || signed.signature.length !== 64) {
            throw new Error("Phantom returned an invalid wallet signature.");
        }
        const signature = btoa(Array.from(signed.signature, (byte) => String.fromCharCode(byte)).join(""));
        button.textContent = "SAVING WALLET…";
        setWalletMessage("Wallet signature received. Saving the wallet link securely on the server…", "pending");
        const linkResponse = await fetch(apiUrl("wallet-link"), {
            method: "POST",
            headers,
            body: JSON.stringify({ action: "verify", walletAddress, signature }),
            cache: "no-store"
        });
        const linkResult = await linkResponse.json().catch(() => ({}));
        if (!linkResponse.ok || linkResult.linked !== true) {
            throw new Error(linkResult.message || linkResult.error || `Wallet verification failed (${linkResponse.status}).`);
        }
        setWalletMessage("Solana wallet ownership is verified and linked. Deposits remain disabled until the treasury and backend checks are ready.", "disabled");
        await refreshWallet();
    } catch (error) {
        console.error("Solana wallet could not be linked.", error);
        setWalletMessage(`Wallet was not linked. ${error.message}`, "error");
    } finally {
        button.disabled = false;
    }
}

async function verifyDepositSignature(signatureOrLink) {
    if (!supabaseConfigured || !supabase) throw new Error("Supabase authentication is unavailable.");
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error("Sign in before submitting a transaction signature.");
    const response = await fetch(apiUrl("deposits"), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ signature: signatureOrLink }),
        cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    const transactionLink = document.getElementById("deposit-transaction-link");
    const transactionResult = document.getElementById("deposit-transaction-result");
    if (typeof result.transactionUrl === "string") {
        transactionLink.href = result.transactionUrl;
        transactionResult.hidden = false;
    } else {
        transactionResult.hidden = true;
    }
    if (response.status === 202) {
        setWalletMessage("Deposit not detected yet. Please wait and check again; no credits have been added.", "pending");
        return false;
    }
    if (response.status === 404 && result.error === "transaction_not_found") {
        setWalletMessage("Deposit not detected yet. Please wait and check again; no credits have been added.", "pending");
        return false;
    }

    if (!response.ok) {
        const messages = {
            transaction_not_found: "Transaction was not found on Solana mainnet. Check again after it has been submitted.",
            transaction_failed: "Solana reports this transaction failed. No credits were added.",
            wrong_token_or_destination: "This transaction does not contain a verified CYFUR transfer to the exact treasury token account. No credits were added.",
            wrong_amount: "The finalized CYFUR transfer is below the 1 CYFUR minimum. No credits were added.",
            payment_intent_mismatch: "This transfer does not include your unique RelicGrid payment memo. No credits were added.",
            transaction_already_claimed: "This transaction has already been claimed or credited to another player. No credits were added.",
            payment_intent_invalid_or_claimed: "This payment reference is invalid, belongs to another player, or was used for a different transaction.",
            invalid_treasury_address: "The configured treasury is not a valid wallet authority. Do not send CYFUR.",
            invalid_treasury_token_account: "The treasury CYFUR account is missing or misconfigured. Deposits are disabled; do not send CYFUR.",
            finalized_transaction_unavailable: "Solana could not provide finalized transaction details yet. No credits were added; retry verification later.",
            payment_intent_time_unverifiable: "The payment intent could not be matched to a verifiable on-chain time. No credits were added.",
            mainnet_deposits_disabled: "Mainnet deposits are not enabled. Do not send CYFUR.",
            deposits_disabled: result.message || "Deposit verification is disabled. Do not send CYFUR.",
            direct_treasury_not_ready: result.message,
            wallet_configuration_incomplete: result.message
        };
        throw new Error(`Rejected: ${messages[result.error] || result.message || result.error || `Deposit verification failed (${response.status}).`}`);
    }
    if (result.status !== "confirmed" || !/^\d+$/.test(String(result.creditAmountCredits)) ||
        !/^\d+$/.test(String(result.balanceCredits))) {
        throw new Error("Backend did not return a confirmed deposit and verified balance.");
    }
    document.getElementById("wallet-balance").textContent = formatCredits(result.balanceCredits);
    document.getElementById("wallet-balance-state").textContent = "CREDITS · BACKEND VERIFIED";
    await refreshWallet();
    setWalletMessage(
        result.alreadyProcessed
            ? `This finalized deposit was already credited. Current verified balance: ${formatCredits(result.balanceCredits)} credits.`
            : `Deposit finalized and credited: ${formatCredits(result.creditAmountCredits)} credits. Current verified balance: ${formatCredits(result.balanceCredits)} credits.`,
        "confirmed"
    );
    return true;
}

async function getWalletAuthorizationHeaders() {
    if (!supabaseConfigured || !supabase) throw new Error("Supabase authentication is unavailable.");
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error("Sign in to your game account before creating deposit instructions.");
    return {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
    };
}

async function requestDepositTransaction(action, payload = {}) {
    const response = await fetch(apiUrl("deposit-transaction"), {
        method: "POST",
        headers: await getWalletAuthorizationHeaders(),
        body: JSON.stringify({ action, ...payload }),
        cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(result.message || result.error || `Deposit transaction request failed (${response.status}).`);
        error.code = result.error;
        error.status = response.status;
        throw error;
    }
    return result;
}

async function handlePhantomMobileCallback(callback) {
    const state = callback.state;
    let broadcastSignature = "";
    let stage = "callback_validation";
    try {
        if (callback.error) throw callback.error;
        await backendReady;
        await refreshWallet();
        if (state.action === "connect") {
            const decrypted = decryptPhantomMobileResponse(window, state, callback.response, true);
            const walletAddress = decrypted.data.public_key;
            const session = decrypted.data.session;
            if (typeof walletAddress !== "string" || typeof session !== "string") {
                throw new Error("Phantom did not return the wallet address and session.");
            }
            savePhantomMobileSession(window, state, {
                walletAddress,
                session,
                sharedSecret: decrypted.sharedSecret,
                phantomPublicKey: decrypted.phantomPublicKey
            });
            const walletConnection = await connectPhantom(window);
            if (!walletConnection || walletConnection.publicKey !== walletAddress) {
                throw new Error("Phantom's returned wallet session did not match its public address.");
            }
            const headers = await getWalletAuthorizationHeaders();
            const challengeResponse = await fetch(apiUrl("wallet-link"), {
                method: "POST",
                headers,
                body: JSON.stringify({ action: "challenge", walletAddress }),
                cache: "no-store"
            });
            const challenge = await challengeResponse.json().catch(() => ({}));
            if (!challengeResponse.ok || typeof challenge.challenge !== "string") {
                throw new Error(challenge.message || challenge.error || `Wallet proof request failed (${challengeResponse.status}).`);
            }
            const provider = walletConnection.provider;
            if (!provider?.signMessage) throw new Error("The secure Phantom mobile session could not be restored.");
            setWalletMessage("Phantom connected. Approve the ownership message in Phantom; this does not transfer tokens.", "pending");
            await provider.signMessage(new TextEncoder().encode(challenge.challenge));
            return;
        }

        const decrypted = decryptPhantomMobileResponse(window, state, callback.response);
        if (state.action === "wallet-link-sign") {
            const signature = decrypted.data.signature;
            if (typeof signature !== "string") throw new Error("Phantom did not return the ownership signature.");
            const headers = await getWalletAuthorizationHeaders();
            const verifyResponse = await fetch(apiUrl("wallet-link"), {
                method: "POST",
                headers,
                body: JSON.stringify({
                    action: "verify",
                    walletAddress: state.walletAddress,
                    signature: bytesToWalletBase64(decodeWalletBytes(signature))
                }),
                cache: "no-store"
            });
            const verifyResult = await verifyResponse.json().catch(() => ({}));
            if (!verifyResponse.ok || verifyResult.linked !== true) {
                throw new Error(verifyResult.message || verifyResult.error || `Wallet verification failed (${verifyResponse.status}).`);
            }
            setPhantomMobilePendingAction(window, { action: "connected", challenge: undefined });
            await refreshWallet();
            const walletConnection = await connectPhantom(window);
            if (walletConnection?.publicKey !== walletStatusSnapshot?.linkedWalletAddress) {
                throw new Error("The Phantom session does not match the wallet linked to this game account.");
            }
            setWalletMessage("Phantom is connected and the wallet ownership proof is linked to this game account.", "ready");
            return;
        }

        if (state.action === "deposit-sign") {
            const config = walletStatusSnapshot;
            if (typeof state.paymentIntentId !== "string" || !/^[0-9a-f-]{36}$/i.test(state.paymentIntentId)) {
                throw new Error("The saved Phantom request is missing its payment intent. No transaction will be broadcast.");
            }
            if (!config?.depositsEnabled || config.network !== state.network) {
                throw new Error("Deposit readiness or network changed while Phantom was open. No transaction was submitted.");
            }
            const walletConnection = await connectPhantom(window);
            if (walletConnection?.publicKey !== config.linkedWalletAddress) {
                throw new Error("The approved Phantom session does not match the linked game wallet. No transaction was submitted.");
            }
            if (typeof decrypted.data.transaction !== "string") {
                throw new Error("Phantom did not return the signed transaction.");
            }
            const transactionBytes = decodeWalletBytes(decrypted.data.transaction);
            stage = "broadcast";
            let broadcast;
            try {
                broadcast = await requestDepositTransaction("broadcast", {
                    paymentIntentId: state.paymentIntentId,
                    transaction: bytesToWalletBase64(transactionBytes)
                });
            } catch (error) {
                if (error.code !== "blockhash_expired") throw error;
                stage = "mobile_blockhash_refresh";
                const paymentIntent = await requestExistingPaymentIntent(state.paymentIntentId);
                if (paymentIntent.network !== config.network ||
                    paymentIntent.sourceWalletAddress !== config.linkedWalletAddress ||
                    paymentIntent.mintAddress !== config.officialMintAddress ||
                    paymentIntent.tokenProgramId !== config.tokenProgramId ||
                    paymentIntent.treasuryAddress !== config.treasuryAddress ||
                    paymentIntent.tokenDecimals !== config.tokenDecimals ||
                    paymentIntent.amountRaw !== state.paymentIntentAmountRaw ||
                    paymentIntent.expiresAt !== state.paymentIntentExpiresAt) {
                    throw new Error("The payment intent changed or expired. Start a new deposit before approving another transaction.");
                }
                const recovery = await rebuildMobileDepositAfterBlockhashRejection({
                    error,
                    state: {
                        ...state,
                        paymentIntentAmountRaw: paymentIntent.amountRaw,
                        paymentIntentExpiresAt: paymentIntent.expiresAt
                    },
                    prepare: () => requestDepositTransaction("prepare"),
                    build: async (preparation) => {
                        const { PublicKey, Transaction, TransactionInstruction } =
                            await loadSolanaWeb3();
                        const payer = new PublicKey(config.linkedWalletAddress);
                        return buildCyfurDepositTransaction({
                            preparation,
                            config,
                            payer,
                            rawAmount: BigInt(paymentIntent.amountRaw),
                            paymentIntentMemo: paymentIntent.memo,
                            PublicKey,
                            Transaction,
                            TransactionInstruction
                        });
                    }
                });
                if (!walletConnection.provider?.isMobileDeepLink) {
                    throw new Error("The Phantom mobile session cannot approve a fresh transaction. Start a new deposit.");
                }
                setWalletMessage("The previous blockhash was rejected before submission. Review and approve a newly built transaction in Phantom; the old signed transaction will not be reused.", "pending");
                stage = "mobile_resign";
                await walletConnection.provider.sendTransaction(recovery.transaction, null, {
                    preflightCommitment: "confirmed",
                    chain: config.network,
                    paymentIntentId: state.paymentIntentId,
                    paymentIntentAmountRaw: state.paymentIntentAmountRaw,
                    paymentIntentExpiresAt: state.paymentIntentExpiresAt,
                    blockhashRetryCount: recovery.blockhashRetryCount
                });
                return;
            }
            broadcastSignature = broadcast.signature;
            document.getElementById("deposit-signature").value = broadcastSignature;
            setWalletMessage("Phantom approved the transaction. Waiting for the server to verify its finalized transfer before crediting.", "pending");
            sessionStorage.setItem("relicgrid.payment-intent.v1", state.paymentIntentId);
            stage = "deposit_verification";
            await verifyDepositSignature(broadcastSignature);
            setPhantomMobilePendingAction(window, { action: "connected" });
            await refreshWallet();
            return;
        }
        throw new Error("The returned Phantom action is not recognized.");
    } catch (error) {
        console.error("Phantom mobile callback could not be completed.", {
            stage,
            errorName: error?.name || "Error",
            errorCode: typeof error?.code === "string" || Number.isInteger(error?.code)
                ? error.code
                : null,
            status: Number.isInteger(error?.status) ? error.status : null,
            errorMessage: typeof error?.message === "string"
                ? error.message
                    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
                    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "[redacted-address]")
                    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "[redacted-data]")
                    .slice(0, 300)
                : "Unknown error"
        });
        if (state?.session) {
            setPhantomMobilePendingAction(window, { action: "connected" });
        } else {
            clearPhantomMobileSession(window);
        }
        if (broadcastSignature) {
            document.getElementById("deposit-signature").value = broadcastSignature;
            sessionStorage.setItem("relicgrid.payment-intent.v1", state.paymentIntentId);
            setWalletMessage(`Transaction was submitted, but credit verification did not complete. Keep the signature and confirm the deposit again after finalization. ${error.message}`, "error");
        } else {
            const message = error.code === "blockhash_expired"
                ? "The signed transaction was rejected before submission. Start the deposit again to fetch a fresh blockhash and approve a new transaction. No credits were added."
                : `Phantom returned to RelicGrid, but the requested action did not complete. ${error.message}`;
            setWalletMessage(message, "error");
        }
    }
}

function showNameOrHome() {
    if (!player.name) {
        showScreen("name-screen");
        playerNameInput.focus();
    } else {
        renderHome();
    }
}

function playCampaignEnding() {
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        stopVideoPlayback(transitionVideo);
        transitionVideo.pause();
        transitionVideo.hidden = true;
        videoSkip.hidden = true;
        videoAction.hidden = true;
        showNameOrHome();
    };
    const offerContinue = (message) => {
        videoCaption.textContent = message;
        videoAction.textContent = "CONTINUE →";
        videoAction.hidden = false;
        videoAction.onclick = finish;
    };

    showScreen("video-screen");
    introVideo.pause();
    introVideo.hidden = true;
    transitionVideo.pause();
    transitionVideo.src = "theend.mp4";
    transitionVideo.currentTime = 0;
    transitionVideo.muted = false;
    if (transitionVideo.readyState >= HTMLMediaElement.HAVE_METADATA) {
        fitVideoFrame(transitionVideo);
    } else {
        transitionVideo.addEventListener("loadedmetadata", () => fitVideoFrame(transitionVideo), { once: true });
    }
    transitionVideo.hidden = false;
    videoAction.hidden = true;
    videoCaption.textContent = "Campaign complete. Final transmission incoming…";
    videoSkip.textContent = "SKIP ENDING →";
    videoSkip.hidden = false;
    videoSkip.onclick = finish;
    transitionVideo.onended = finish;
    transitionVideo.onerror = () => {
        console.error("Campaign ending video could not be decoded.", transitionVideo.error);
        offerContinue("The campaign ending video could not be played.");
    };

    playVideoInLandscape(transitionVideo, (error) => {
        console.warn("Campaign ending video could not autoplay.", error);
        videoCaption.textContent = "Tap to play the final transmission.";
        videoAction.textContent = "PLAY ENDING →";
        videoAction.hidden = false;
        videoAction.onclick = () => playVideoInLandscape(transitionVideo, (retryError) => {
            console.error("Campaign ending video could not start after interaction.", retryError);
            offerContinue("The campaign ending video could not be played.");
        });
    });
}

function playLevelTransition(nextLevel) {
    const transitionClips = ["levels.mp4", "levels2.mp4"];
    const clip = transitionClips[interstitialClipIndex];
    interstitialClipIndex = (interstitialClipIndex + 1) % transitionClips.length;
    nextInterstitialAt = player.completedLevels.length + randomTransitionInterval();
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        stopVideoPlayback(transitionVideo);
        transitionVideo.pause();
        transitionVideo.hidden = true;
        videoSkip.hidden = true;
        videoAction.hidden = true;
        startLevel(nextLevel, true);
    };
    const offerContinue = (error) => {
        console.error(`Inter-level transmission ${clip} could not be played.`, error);
        videoCaption.textContent = "Transmission unavailable. Continue to the next sector when ready.";
        videoAction.textContent = "CONTINUE →";
        videoAction.hidden = false;
        videoAction.onclick = finish;
    };

    showScreen("video-screen");
    stopVideoPlayback(introVideo);
    introVideo.pause();
    introVideo.hidden = true;
    transitionVideo.pause();
    transitionVideo.src = clip;
    transitionVideo.currentTime = 0;
    transitionVideo.muted = false;
    if (transitionVideo.readyState >= HTMLMediaElement.HAVE_METADATA) {
        fitVideoFrame(transitionVideo);
    } else {
        transitionVideo.addEventListener("loadedmetadata", () => fitVideoFrame(transitionVideo), { once: true });
    }
    transitionVideo.hidden = false;
    videoAction.hidden = true;
    videoCaption.textContent = `Sector ${String(nextLevel).padStart(2, "0")} transmission incoming…`;
    videoSkip.textContent = "SKIP TRANSMISSION →";
    videoSkip.hidden = false;
    videoSkip.onclick = finish;
    transitionVideo.onended = finish;
    transitionVideo.onerror = () => offerContinue(transitionVideo.error);
    playVideoInLandscape(transitionVideo, offerContinue);
}

function beginGameIntro() {
    stopVideoPlayback(introVideo);
    introVideo.pause();
    introVideo.hidden = true;
    transitionVideo.hidden = false;
    transitionVideo.src = "gamevideo.mp4";
    transitionVideo.currentTime = 0;
    transitionVideo.muted = false;
    if (transitionVideo.readyState >= HTMLMediaElement.HAVE_METADATA) {
        fitVideoFrame(transitionVideo);
    } else {
        transitionVideo.addEventListener("loadedmetadata", () => fitVideoFrame(transitionVideo), { once: true });
    }
    videoSkip.hidden = false;
    videoSkip.onclick = () => {
        transitionVideo.pause();
        stopVideoPlayback(transitionVideo);
        transitionVideo.hidden = true;
        videoSkip.hidden = true;
        showNameOrHome();
    };
    transitionVideo.onended = () => {
        player.watchedGameIntro = true;
        savePlayer();
        stopVideoPlayback(transitionVideo);
        transitionVideo.pause();
        transitionVideo.hidden = true;
        videoSkip.hidden = true;
        videoCaption.textContent = "Welcome, pilot.";
        showNameOrHome();
    };
    transitionVideo.onerror = () => {
        console.error("Gameplay introduction video could not be decoded.", transitionVideo.error);
        videoCaption.textContent = "This browser could not play the introduction video.";
        videoAction.textContent = "CONTINUE WITHOUT VIDEO  →";
        videoAction.hidden = false;
        videoAction.onclick = () => {
            stopVideoPlayback(transitionVideo);
            transitionVideo.hidden = true;
            videoSkip.hidden = true;
            showNameOrHome();
        };
    };
    videoAction.hidden = true;
    videoCaption.textContent = "Initializing your first mission…";
    playVideoInLandscape(transitionVideo, (error) => {
        console.warn("Gameplay introduction video could not start.", error);
        videoCaption.textContent = "Tap to play the gameplay introduction with sound.";
        videoAction.textContent = "PLAY VIDEO WITH SOUND  →";
        videoAction.hidden = false;
        videoAction.onclick = () => playVideoInLandscape(transitionVideo, (retryError) => {
            console.error("Gameplay introduction video could not start after interaction.", retryError);
            videoCaption.textContent = "The gameplay introduction could not be played.";
            videoAction.textContent = "CONTINUE WITHOUT VIDEO  →";
            videoAction.hidden = false;
            videoAction.onclick = () => {
                stopVideoPlayback(transitionVideo);
                transitionVideo.hidden = true;
                videoSkip.hidden = true;
                showNameOrHome();
            };
        });
    });
}

function continueAfterIntro() {
    beginGameIntro();
}

function showOpeningIntro() {
    if (new URL(window.location.href).searchParams.has("phantom_handoff") && player.name) {
        introVideo.pause();
        transitionVideo.pause();
        showNameOrHome();
        document.getElementById("wallet-card").scrollIntoView({ behavior: "auto", block: "start" });
        void backendReady.then(() => refreshWallet());
        return;
    }
    stopVideoPlayback(transitionVideo);
    showScreen("video-screen");
    transitionVideo.hidden = true;
    introVideo.hidden = false;
    introVideo.muted = false;
    fitVideoFrame(introVideo);
    if (introVideo.readyState < HTMLMediaElement.HAVE_METADATA) {
        introVideo.addEventListener("loadedmetadata", () => fitVideoFrame(introVideo), { once: true });
    }
    videoSkip.hidden = true;
    videoSkip.onclick = () => {
        stopVideoPlayback(introVideo);
        introVideo.pause();
        transitionVideo.pause();
        introVideo.hidden = true;
        transitionVideo.hidden = true;
        videoSkip.hidden = true;
        showNameOrHome();
    };
    videoAction.textContent = "Play Now  →";
    videoAction.hidden = false;
    videoAction.onclick = continueAfterIntro;
    videoCaption.textContent = player.watchedGameIntro ? "Welcome back, pilot." : "Your first signal is ready.";
    introVideo.onended = () => {
        videoCaption.textContent = "Your first signal is ready.";
    };
    introVideo.onerror = () => {
        console.error("Opening introduction video could not be decoded.", introVideo.error);
        videoCaption.textContent = "This browser could not play the opening video.";
        videoAction.textContent = "CONTINUE WITHOUT VIDEO  →";
        videoAction.hidden = false;
        videoAction.onclick = continueAfterIntro;
    };
    playVideoInLandscape(introVideo, (error) => {
        console.warn("Opening introduction video could not autoplay.", error);
        videoCaption.textContent = "Your first signal is ready.";
    });
}

function fitVideoFrame(video) {
    if (!video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(
        (window.innerWidth - 24) / video.videoWidth,
        (window.innerHeight - 24) / video.videoHeight
    );
    videoScreen.style.setProperty("--phone-width", `${video.videoWidth * scale}px`);
    videoScreen.style.setProperty("--phone-height", `${video.videoHeight * scale}px`);
}

async function startLevel(number, resumeMusic = false) {
    if (await refreshLevelsLockState()) {
        showScreen("home-screen");
        setLevelEntryMessage("All 99 levels are temporarily locked. Your saved progress remains intact.", "disabled");
        return;
    }
    const level = levels[number - 1];
    if (!level) return;
    const gameGuide = document.getElementById("game-guide");
    const showTutorial = number === 1 && !player.tutorialSeen;
    gameGuide.hidden = !showTutorial;
    document.getElementById("first-level-tutorial").hidden = !showTutorial;
    document.getElementById("game-guide-toggle").setAttribute("aria-expanded", String(showTutorial));
    activeWalletLevelSessionId = null;
    walletTimerStartPromise = Promise.resolve(false);
    setLevelEntryMessage("Free gameplay testing is enabled. No credits are charged or awarded.", "ready");
    player.lastLevel = number;
    pendingLevel = level;
    savePlayer();
    document.getElementById("play-level").textContent = `LEVEL ${String(number).padStart(2, "0")}`;
    document.getElementById("play-level-title").textContent = level.title;
    showScreen("play-screen");
    window.setTimeout(() => {
        window.fluxGridSceneResize?.();
        window.dispatchEvent(new CustomEvent("fluxgrid:load-level", {
            detail: {
                level,
                walletSessionId: activeWalletLevelSessionId,
                tutorial: showTutorial
            }
        }));
    }, 0);
    if (resumeMusic || !musicStarted) startMusic();
}

function leaveGameplay(toHome = true) {
    stopMusic();
    if (toHome) renderHome();
}

document.getElementById("name-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = playerNameInput.value.trim();
    if (!name) return;
    if (supabaseConfigured) {
        await backendReady;
        if (authUser) {
            const { error } = await supabase.rpc("set_player_display_name", {
                p_display_name: name.slice(0, 20)
            });
            if (error) {
                console.error("Player callsign could not be saved to Supabase.", error);
                backendStatus = `Callsign could not be synced: ${error.message}`;
            }
        }
    }
    player.name = name.slice(0, 20);
    savePlayer();
    renderProfile();
    renderHome();
});

document.getElementById("continue-game").addEventListener("click", () => {
    startLevel(getContinueLevel());
});
document.getElementById("next-level").addEventListener("click", (event) => {
    const number = Number(event.currentTarget.dataset.nextLevel);
    if (!Number.isInteger(number) || number < 1 || number > 99) return;
    if (player.completedLevels.length >= nextInterstitialAt) {
        playLevelTransition(number);
    } else {
        startLevel(number, true);
    }
});
document.getElementById("home-levels-toggle").addEventListener("click", (event) => {
    const button = event.currentTarget;
    const section = document.getElementById("level-section");
    const expanded = button.getAttribute("aria-expanded") === "true";
    section.hidden = expanded;
    button.setAttribute("aria-expanded", String(!expanded));
    if (!expanded) {
        section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
});
document.getElementById("leaderboard-open").addEventListener("click", () => {
    showScreen("leaderboard-screen");
    void refreshLeaderboard();
});
document.getElementById("leaderboard-refresh").addEventListener("click", () => {
    void refreshLeaderboard();
});
document.getElementById("wallet-refresh").addEventListener("click", () => {
    void refreshWallet();
});
document.getElementById("wallet-balance-refresh").addEventListener("click", () => {
    void refreshWallet();
});
document.getElementById("wallet-copy-address").addEventListener("click", async () => {
    const address = document.getElementById("wallet-address").textContent.trim();
    if (!address || address === "Not configured") {
        setWalletMessage("The owner-controlled treasury is not configured. Do not send tokens.", "disabled");
        return;
    }
    try {
        await navigator.clipboard.writeText(address);
        const depositsReady = walletStatusSnapshot?.depositsEnabled === true;
        document.getElementById("wallet-address-copy-status").textContent = "Treasury address copied.";
        setWalletMessage(
            depositsReady
                ? "Treasury copied. Send only official CYFUR on Solana and include your unique payment memo."
                : "Treasury address copied for setup only. Deposit verification is not READY; do not send CYFUR.",
            depositsReady ? "ready" : "disabled"
        );
    } catch (error) {
        console.error("Deposit address could not be copied.", error);
        document.getElementById("wallet-address-copy-status").textContent = "Copy failed. Select the address to copy it.";
        setWalletMessage(`Address copy failed. Select and copy it manually. ${error.message}`, "error");
    }
});
document.getElementById("wallet-copy-memo").addEventListener("click", async () => {
    try {
        const memo = document.getElementById("deposit-required-memo").textContent.trim();
        if (!memo) return;
        await navigator.clipboard.writeText(memo);
        setWalletMessage("Payment memo copied. Add it to the Solana transfer exactly as shown.", "ready");
    } catch (error) {
        console.error("Memo could not be copied.", error);
        setWalletMessage(`Memo copy failed. Copy it manually. ${error.message}`, "error");
    }
});
document.getElementById("deposit-signature-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("deposit-signature");
    const button = document.getElementById("deposit-verify-button");
    const signatureOrLink = input.value.trim();
    if (!signatureOrLink) return;
    button.disabled = true;
    button.textContent = "VERIFYING…";
    setWalletMessage("Verifying your CYFUR transaction on Solana…", "verifying");
    try {
        await verifyDepositSignature(signatureOrLink);
    } catch (error) {
        console.error("Deposit signature verification failed.", error);
        setWalletMessage(error.message, "error");
    } finally {
        button.disabled = walletStatusSnapshot?.depositsEnabled !== true;
        button.textContent = "VERIFY PAYMENT →";
    }
});
document.getElementById("profile-open").addEventListener("click", () => {
    renderProfile();
    showScreen("profile-screen");
});
document.getElementById("levels-open").addEventListener("click", () => leaveGameplay());
document.getElementById("play-home").addEventListener("click", () => leaveGameplay());
document.getElementById("game-guide-toggle").addEventListener("click", (event) => {
    const button = event.currentTarget;
    const guide = document.getElementById("game-guide");
    const expanded = button.getAttribute("aria-expanded") === "true";
    guide.hidden = expanded;
    button.setAttribute("aria-expanded", String(!expanded));
});
document.getElementById("game-guide-close").addEventListener("click", () => {
    document.getElementById("game-guide").hidden = true;
    document.getElementById("first-level-tutorial").hidden = true;
    if (pendingLevel?.number === 1) {
        player.tutorialSeen = true;
        savePlayer();
    }
    const button = document.getElementById("game-guide-toggle");
    button.setAttribute("aria-expanded", "false");
    button.focus();
});
document.querySelectorAll("[data-home]").forEach((button) => button.addEventListener("click", renderHome));

async function saveLevelCompletion(number) {
    if (authUser && supabaseConfigured) {
        try {
            await backendReady;
            const { error } = await supabase.rpc("record_level_completion", {
                p_level_number: number
            });
            if (error) throw error;
            await refreshOwnProgress();
            backendStatus = "Connected to the RelicGrid leaderboard.";
        } catch (error) {
            console.error("Level completion could not be saved to Supabase.", error);
            if (!player.completedLevels.includes(number)) player.completedLevels.push(number);
            player.unlockedLevel = Math.max(player.unlockedLevel, Math.min(99, number + 1));
            backendStatus = `Offline: level ${number} is only saved on this device. ${error.message}`;
            const status = document.getElementById("game-status");
            status.textContent = `Level ${number} solved, but leaderboard sync failed. Your progress is currently local only.`;
        }
    } else {
        if (!player.completedLevels.includes(number)) player.completedLevels.push(number);
        player.unlockedLevel = Math.max(player.unlockedLevel, Math.min(99, number + 1));
    }
    savePlayer();
    renderProfile();
    if (!document.getElementById("leaderboard-screen").hidden) {
        await refreshLeaderboard();
    }
}

async function saveWalletLevelCompletion(detail) {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error("Player authentication expired before completion was saved.");
    await walletTimerStartPromise;
    const response = await fetch(apiUrl("level-completion"), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            sessionId: detail.walletSessionId,
            mirrors: detail.mirrors,
            launchDirection: detail.launchDirection
        }),
        cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status !== "confirmed") {
        throw new Error(result.error || `Secure completion failed (${response.status}).`);
    }

    document.getElementById("completion-stars").textContent = `${result.stars} / 3`;
    document.getElementById("completion-star-icons").textContent =
        `${"★".repeat(result.stars)}${"☆".repeat(3 - result.stars)}`;
    if (Number.isFinite(result.elapsedMilliseconds) && result.elapsedMilliseconds >= 0) {
        document.getElementById("completion-time").textContent =
            `${(result.elapsedMilliseconds / 1000).toFixed(1)} s`;
    }
    document.getElementById("wallet-balance").textContent = formatCredits(result.balanceCredits);
    document.getElementById("wallet-balance-state").textContent = "CREDITS · BACKEND VERIFIED";
    const rewardLabel = document.getElementById("completion-reward-label");
    const reward = document.getElementById("completion-reward");
    const rewardNote = document.getElementById("completion-reward-note");
    rewardLabel.textContent = result.rewardCredits === "0" ? "NO REWARD" : "CONFIRMED CREDIT REWARD";
    reward.textContent = `${formatCredits(result.rewardCredits)} credits`;
    rewardNote.textContent = result.duplicate
        ? "Level already cleared · repeat reward prevented"
        : "Verified and credited by the server";

    await refreshOwnProgress();
    backendStatus = "Connected to the RelicGrid leaderboard.";
    return result;
}

const withdrawalAddressInput = document.getElementById("withdrawal-wallet-address");
const withdrawalAmountInput = document.getElementById("withdrawal-amount");
const withdrawalValidateButton = document.getElementById("withdrawal-validate-address");
const withdrawalForm = document.getElementById("withdrawal-form");
if (withdrawalForm && withdrawalAddressInput && withdrawalAmountInput && withdrawalValidateButton) {
    withdrawalValidateButton.addEventListener("click", validateWithdrawalAddress);
    withdrawalAddressInput.addEventListener("input", () => {
        const value = (withdrawalAddressInput.value || "").trim();
        if (!value) {
            setWithdrawalStatus("Enter the Solana wallet address that should receive CYFUR.", "error");
            return;
        }
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
            setWithdrawalStatus("This wallet address is not yet a valid Solana public key.", "error");
            return;
        }
        setWithdrawalStatus("This wallet address looks valid and is ready for a withdrawal review.", "ready");
    });
    withdrawalAmountInput.addEventListener("input", () => {
        const value = (withdrawalAmountInput.value || "").trim();
        if (!/^\d*$/.test(value)) {
            setWithdrawalStatus("Only whole credit values can be withdrawn.", "error");
            return;
        }
        updateWithdrawalPreview();
    });
    withdrawalForm.addEventListener("submit", submitWithdrawalRequest);
}

window.addEventListener("fluxgrid:level-timer-start", (event) => {
    const sessionId = event.detail?.walletSessionId;
    if (!sessionId || sessionId !== activeWalletLevelSessionId) return;
    walletTimerStartPromise = (async () => {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        const accessToken = data.session?.access_token;
        if (!accessToken) throw new Error("Player authentication expired before the timer started.");
        const response = await fetch(apiUrl("level-session"), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ sessionId }),
            cache: "no-store"
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.startedAt) {
            throw new Error(result.error || `Server timer could not start (${response.status}).`);
        }
        return true;
    })();
    void walletTimerStartPromise.catch((error) => {
        console.error("Server-authoritative level timer did not start.", error);
        document.getElementById("game-status").textContent =
            "Server timer could not start. Completion will not be credited; please retry after checking your connection.";
    });
});

window.addEventListener("fluxgrid:level-complete", async (event) => {
    if (await refreshLevelsLockState()) {
        setLevelEntryMessage("The campaign is temporarily locked. No completion or reward was recorded.", "disabled");
        showScreen("home-screen");
        return;
    }
    const detail = event.detail ?? {};
    const number = detail.number;
    if (!Number.isInteger(number) || number < 1 || number > 99) {
        console.error("Invalid completed-level event received.", detail);
        return;
    }
    if (number === 1 && !player.tutorialSeen) {
        player.tutorialSeen = true;
        savePlayer();
    }

    if (detail.walletSessionId) {
        try {
            const result = await saveWalletLevelCompletion(detail);
            setLevelEntryMessage(
                `Level ${number} saved. ${result.rewardCredits} credits ${result.rewardCredits === "0" ? "awarded" : "confirmed"}; balance is backend verified.`,
                "success"
            );
        } catch (error) {
            console.error("Server-verified level completion could not be saved.", error);
            document.getElementById("game-status").textContent =
                `Level ${number} is not recorded and no reward was credited: ${error.message}`;
            return;
        }
    } else if (claimLevelCompletion(number, processedLevelCompletions)) {
        player.unlockedLevel = Math.max(player.unlockedLevel, Math.min(99, number + 1));
        if (!player.completedLevels.includes(number)) player.completedLevels.push(number);
        savePlayer();
        if (number < 99) {
            const nextLevelButton = document.getElementById("next-level");
            nextLevelButton.dataset.nextLevel = String(number + 1);
            nextLevelButton.disabled = false;
        }
        await saveLevelCompletion(number);
    }

    const nextLevelButton = document.getElementById("next-level");
    if (pendingLevel?.number === number) {
        nextLevelButton.hidden = false;
        nextLevelButton.disabled = number >= 99;
        nextLevelButton.dataset.nextLevel = String(number + 1);
        nextLevelButton.textContent = number >= 99 ? "CAMPAIGN COMPLETE" : "NEXT LEVEL →";
    }
    renderProfile();
    if (number === 99) playCampaignEnding();
});

backendReady = initializeBackend();
void refreshLevelsLockState();
window.addEventListener("focus", () => void refreshLevelsLockState());
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshLevelsLockState();
});
window.setInterval(() => void refreshLevelsLockState(), 30000);
const phantomMobileCallback = readPhantomMobileCallback(window);
if (phantomMobileCallback) {
    showNameOrHome();
    document.getElementById("wallet-card").scrollIntoView({ behavior: "auto", block: "start" });
    void handlePhantomMobileCallback(phantomMobileCallback);
} else if (new URL(window.location.href).searchParams.has("phantom_handoff") && player.name) {
    showNameOrHome();
    document.getElementById("wallet-card").scrollIntoView({ behavior: "auto", block: "start" });
} else {
    showOpeningIntro();
}
