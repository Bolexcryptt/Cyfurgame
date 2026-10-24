import { CYFUR_CREDITS_PER_TOKEN, levels, claimLevelCompletion } from "./levels.js";
import { supabase, supabaseConfigured } from "./supabase.js";
import {
    bytesToWalletBase64,
    clearPhantomMobileSession,
    connectPhantom,
    decodeWalletBytes,
    decryptPhantomMobileResponse,
    encodeWalletBytes,
    getConnectedPhantomWallet,
    getPhantomProvider,
    isMobileBrowser,
    readPhantomMobileCallback,
    savePhantomMobileSession,
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
const videoAction = document.getElementById("video-action-button");
const videoSkip = document.getElementById("video-skip-button");
const videoCaption = document.getElementById("video-caption");
const backgroundMusic = document.getElementById("background-music");
const playerNameInput = document.getElementById("player-name");
document.getElementById("wallet-exchange-rate").textContent =
    `1 CYFUR = ${CYFUR_CREDITS_PER_TOKEN.toLocaleString("en-US")} CREDITS`;

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
let pendingLevel = null;
let activeWalletLevelSessionId = null;
let walletTimerStartPromise = Promise.resolve(false);
const processedLevelCompletions = new Set();
const pendingLevelEntryRequests = new Map();
let levelEntryRequestInProgress = false;
let introFinished = false;
let musicStarted = false;
let authUser = null;
let backendStatus = supabaseConfigured ? "Connecting to Supabase…" : "Supabase is not configured.";
let backendReady;
let walletStatusSnapshot = null;
let solanaWeb3ModulePromise = null;

function savePlayer() {
    localStorage.setItem(storageKey, JSON.stringify(player));
}

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

function renderLevels() {
    const list = document.getElementById("level-list");
    const fragment = document.createDocumentFragment();
    const continueLevel = getContinueLevel();
    for (const level of levels) {
        const completed = player.completedLevels.includes(level.number);
        const current = level.number === continueLevel && !completed;
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.style.setProperty("--card-index", String((level.number - 1) % 12));
        button.className = `level-card is-unlocked${completed ? " is-complete" : ""}${current ? " is-current" : ""}`;
        button.type = "button";
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
        entryCost.textContent = "FREE PLAY";
        detail.append(title, meta);
        const badge = document.createElement("span");
        badge.className = "level-state";
        badge.textContent = completed ? "CLEARED" : current ? "NEXT UP" : "PLAY";
        const cost = document.createElement("span");
        cost.className = "level-entry-cost";
        cost.append(entryCost);
        button.append(number, detail, cost, badge);
        button.setAttribute("aria-label", `Play level ${level.number}, free play${completed ? ", completed" : ""}`);
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

            const response = await fetch("/api/level-entry", {
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
}

function renderWalletConnectionState() {
    const connectedAddress = getConnectedPhantomWallet(window)?.publicKey ?? null;
    const linkedAddress = walletStatusSnapshot?.linkedWalletAddress ?? null;
    const addressElement = document.getElementById("wallet-player-address");
    const stateElement = document.getElementById("wallet-player-state");
    const button = document.getElementById("fund-account-button");
    addressElement.textContent = linkedAddress ?? "No wallet linked";
    addressElement.closest(".wallet-data-panel").hidden = !linkedAddress;
    if (connectedAddress && connectedAddress === linkedAddress) {
        stateElement.textContent = "PHANTOM CONNECTED · LINK VERIFIED";
        button.textContent = "PHANTOM CONNECTED";
    } else if (connectedAddress) {
        stateElement.textContent = "PHANTOM CONNECTED · LINK THIS WALLET";
        button.textContent = "LINK CONNECTED WALLET";
    } else if (linkedAddress) {
        stateElement.textContent = "WALLET LINKED · PHANTOM NOT CONNECTED IN THIS TAB";
        button.textContent = "CONNECT LINKED WALLET";
    } else {
        stateElement.textContent = "PHANTOM NOT CONNECTED";
        button.textContent = "CONNECT SOLANA WALLET";
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

async function refreshWallet() {
    const address = document.getElementById("wallet-address");
    const copyButton = document.getElementById("wallet-copy-address");
    const signatureInput = document.getElementById("deposit-signature");
    const signatureSubmit = document.getElementById("deposit-verify-button");
    const balance = document.getElementById("wallet-balance");
    const status = document.getElementById("wallet-status-value");
    const refreshButton = document.getElementById("wallet-refresh");
    const balanceRefreshButton = document.getElementById("wallet-balance-refresh");
    const amountInput = document.getElementById("wallet-transfer-amount");
    const transferButton = document.getElementById("wallet-transfer-button");
    walletStatusSnapshot = null;
    refreshButton.disabled = true;
    refreshButton.textContent = "LOADING";
    balanceRefreshButton.disabled = true;
    balanceRefreshButton.textContent = "CHECKING BALANCE…";
    transferButton.disabled = true;
    copyButton.disabled = true;
    address.textContent = "Not configured";
    status.textContent = "DISABLED";
    balance.textContent = "Unavailable";
    document.getElementById("wallet-balance-state").textContent = "CREDITS · NOT VERIFIED";
    signatureInput.disabled = true;
    signatureSubmit.disabled = true;
    renderWalletHistory(null);

    try {
        if (!supabaseConfigured || !supabase) {
            setWalletMessage("Supabase is not configured; wallet data is unavailable and deposits remain disabled.", "error");
            return;
        }
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        const accessToken = data.session?.access_token;
        if (!accessToken) {
            setWalletMessage("Sign in to view wallet data. Deposits remain disabled.", "error");
            return;
        }

        const response = await fetch("/api/wallet", {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: "no-store"
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (result.error === "wallet_schema_not_installed") {
                setWalletMessage("Apply the wallet and direct-treasury Supabase migrations, then deploy the Vercel API.", "error");
                return;
            }
            if (result.error === "wallet_api_not_configured") {
                setWalletMessage("Vercel wallet API is missing SUPABASE_URL and/or SUPABASE_PUBLISHABLE_KEY. Configure both as server-side Vercel environment variables; deposits remain disabled.", "error");
                return;
            }
            if (result.error === "authentication_required") {
                setWalletMessage("Your RelicGrid identity could not be authenticated by the wallet API.", "error");
                return;
            }
            if (response.status === 404 || response.status === 501) {
                setWalletMessage("The wallet API is not available on this host. Deploy the Vercel project with its /api routes before wallet status can be checked. Deposits remain disabled; do not send CYFUR.", "error");
                return;
            }
            throw new Error(result.error || `Wallet request failed (${response.status}).`);
        }

        if (result.treasuryAddress) {
            address.textContent = result.treasuryAddress;
            copyButton.disabled = false;
        }
        walletStatusSnapshot = result;
        const linkedAddressElement = document.getElementById("wallet-player-address");
        linkedAddressElement.textContent = result.linkedWalletAddress ?? "No wallet linked";
        linkedAddressElement.closest(".wallet-data-panel").hidden = !result.linkedWalletAddress;
        renderWalletConnectionState();
        const depositReady = result.depositsEnabled === true &&
            Boolean(result.linkedWalletAddress) &&
            Boolean(result.officialMintAddress) &&
            Boolean(result.tokenProgramId) &&
            Number.isInteger(result.tokenDecimals);
        amountInput.disabled = !depositReady;
        transferButton.disabled = !depositReady;
        signatureInput.disabled = result.depositsEnabled !== true || !result.linkedWalletAddress;
        signatureSubmit.disabled = result.depositsEnabled !== true || !result.linkedWalletAddress;
        balance.textContent = result.balanceCredits === null
            ? "Unavailable"
            : formatCredits(result.balanceCredits);
        document.getElementById("wallet-balance-state").textContent =
            result.balanceVerified === true ? "CREDITS · BACKEND VERIFIED" : "CREDITS · NOT VERIFIED";
        status.textContent = result.depositsEnabled === true
            ? `READY${result.network ? ` · ${result.network.toUpperCase()}` : ""}`
            : result.linkedWalletAddress ? "WALLET LINKED · VERIFICATION OFF" : "DISABLED";
        renderWalletHistory(result.deposits);
        setWalletMessage(
            result.depositsEnabled === true
                ? "Deposit service is enabled by the server."
                : result.disabledMessage || "Funding is disabled by the server. No transfer will be accepted or credited; do not send CYFUR.",
            result.depositsEnabled === true ? "ready" : "disabled"
        );
    } catch (error) {
        console.error("Wallet data could not be refreshed.", error);
        setWalletMessage(`Wallet data is unavailable. Deposits remain disabled. ${error.message}`, "error");
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

async function sendCyfurDeposit() {
    const config = walletStatusSnapshot;
    if (!config?.depositsEnabled || !config.linkedWalletAddress ||
        !config.treasuryAddress || !config.officialMintAddress ||
        !config.tokenProgramId || !Number.isInteger(config.tokenDecimals)) {
        setWalletMessage("The server has not marked deposits READY. No token transfer was started.", "disabled");
        return;
    }
    const transferButton = document.getElementById("wallet-transfer-button");
    const mainButton = document.getElementById("fund-account-button");
    const amountInput = document.getElementById("wallet-transfer-amount");
    let signature = "";
    try {
        if (!getPhantomProvider(window)) {
            showPhantomUnavailableMessage();
            return;
        }
        const walletConnection = await withWalletTimeout(
            connectPhantom(window),
            "Phantom connection approval"
        );
        if (!walletConnection || typeof walletConnection.provider.sendTransaction !== "function") {
            showPhantomUnavailableMessage();
            return;
        }
        const { provider } = walletConnection;
        renderWalletConnectionState();
        const rawAmount = parseTokenAmount(amountInput.value, config.tokenDecimals);
        const { PublicKey, Transaction, TransactionInstruction, Connection, clusterApiUrl } =
            await loadSolanaWeb3();
        const payer = new PublicKey(walletConnection.publicKey);
        if (payer.toString() !== config.linkedWalletAddress) {
            throw new Error("The connected Phantom account differs from the wallet linked to this game account. Relink the correct wallet first.");
        }
        const treasury = new PublicKey(config.treasuryAddress);
        const mint = new PublicKey(config.officialMintAddress);
        const tokenProgramId = new PublicKey(config.tokenProgramId);
        const senderTokenAccount = getAssociatedTokenAddress(PublicKey, payer, mint, tokenProgramId);
        const treasuryTokenAccount = getAssociatedTokenAddress(PublicKey, treasury, mint, tokenProgramId);
        const preparation = await requestDepositTransaction("prepare");
        const senderInfo = preparation.senderTokenAccounts.includes(senderTokenAccount.toString());
        const treasuryInfo = preparation.treasuryTokenAccounts.includes(treasuryTokenAccount.toString());
        const instructions = [];
        if (!senderInfo) {
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
        if (!treasuryInfo) {
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
        const transaction = new Transaction({
            feePayer: payer,
            recentBlockhash: preparation.blockhash
        }).add(...instructions);
        const connection = new Connection(clusterApiUrl(config.network), "confirmed");
        transferButton.disabled = true;
        mainButton.disabled = true;
        setWalletMessage("Review the CYFUR amount and recipient in Phantom, then approve the transfer. RelicGrid will verify it before crediting.", "pending");
        const result = await provider.sendTransaction(transaction, connection, {
            preflightCommitment: "confirmed",
            ...(provider.isWalletStandard ? { chain: config.network } : {})
        });
        signature = typeof result === "string" ? result : result.signature;
        if (!signature) throw new Error("Phantom did not return a transaction signature.");
        document.getElementById("deposit-signature").value = signature;
        setWalletMessage("Transfer submitted. Waiting for the backend to verify successful finalized confirmation; no credits are shown until it confirms.", "pending");
        await verifyDepositSignature(signature);
        amountInput.value = "";
    } catch (error) {
        console.error("Wallet transfer could not be completed or verified.", error);
        if (signature) {
            document.getElementById("deposit-signature").value = signature;
            setWalletMessage(`Transfer was submitted, but credit verification did not complete. Keep this signature and use VERIFY & CREDIT after the transaction finalizes. ${error.message}`, "error");
        } else {
            setWalletMessage(`Transfer was not completed. ${error.message}`, "error");
        }
    } finally {
        transferButton.disabled = walletStatusSnapshot?.depositsEnabled !== true;
        mainButton.disabled = false;
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
        renderWalletConnectionState();
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
        const challengeResponse = await fetch("/api/wallet-link", {
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
        const linkResponse = await fetch("/api/wallet-link", {
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
        renderWalletConnectionState();
    }
}

async function verifyDepositSignature(signature) {
    if (!supabaseConfigured || !supabase) throw new Error("Supabase authentication is unavailable.");
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error("Sign in before submitting a transaction signature.");
    const response = await fetch("/api/deposits", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ signature }),
        cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 202) {
        setWalletMessage("Transaction is not finalized yet. Wait a little and submit the same signature again; no credits have been added.", "pending");
        return;
    }

    if (!response.ok) {
        const messages = {
            transaction_not_found: "Transaction was not found on the configured Solana network.",
            transaction_failed: "Solana reports this transaction failed. No credits were added.",
            wrong_token_or_destination: "This transfer does not match your linked sender wallet, the treasury, and approved CYFUR mint. No credits were added.",
            mainnet_deposits_disabled: "Mainnet deposits are not enabled. Do not send CYFUR.",
            deposits_disabled: result.message || "Deposit verification is disabled. Do not send CYFUR.",
            direct_treasury_not_ready: result.message,
            solana_wallet_not_linked: result.message,
            wallet_configuration_incomplete: result.message
        };
        throw new Error(messages[result.error] || result.message || result.error || `Deposit verification failed (${response.status}).`);
    }
    if (result.status !== "confirmed" || !/^\d+$/.test(String(result.creditAmountCredits)) ||
        !/^\d+$/.test(String(result.balanceCredits))) {
        throw new Error("Backend did not return a confirmed deposit and verified balance.");
    }
    document.getElementById("wallet-balance").textContent = formatCredits(result.balanceCredits);
    document.getElementById("wallet-balance-state").textContent = "CREDITS · BACKEND VERIFIED";
    setWalletMessage(
        result.alreadyProcessed
            ? `This finalized deposit was already credited. Current verified balance: ${formatCredits(result.balanceCredits)} credits.`
            : `Deposit finalized and credited: ${formatCredits(result.creditAmountCredits)} credits. Current verified balance: ${formatCredits(result.balanceCredits)} credits.`,
        "ready"
    );
    await refreshWallet();
}

async function getWalletAuthorizationHeaders() {
    if (!supabaseConfigured || !supabase) throw new Error("Supabase authentication is unavailable.");
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error("Sign in before using Phantom.");
    return {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
    };
}

async function requestDepositTransaction(action, payload = {}) {
    const response = await fetch("/api/deposit-transaction", {
        method: "POST",
        headers: await getWalletAuthorizationHeaders(),
        body: JSON.stringify({ action, ...payload }),
        cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.message || result.error || `Deposit transaction request failed (${response.status}).`);
    }
    return result;
}

async function handlePhantomMobileCallback(callback) {
    const state = callback.state;
    let broadcastSignature = "";
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
            const challengeResponse = await fetch("/api/wallet-link", {
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
            const verifyResponse = await fetch("/api/wallet-link", {
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
            renderWalletConnectionState();
            return;
        }

        if (state.action === "deposit-sign") {
            const config = walletStatusSnapshot;
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
            const broadcast = await requestDepositTransaction("broadcast", {
                transaction: bytesToWalletBase64(transactionBytes)
            });
            broadcastSignature = broadcast.signature;
            document.getElementById("deposit-signature").value = broadcastSignature;
            setWalletMessage("Phantom approved the transaction. Waiting for the server to verify its finalized transfer before crediting.", "pending");
            await verifyDepositSignature(broadcastSignature);
            setPhantomMobilePendingAction(window, { action: "connected" });
            await refreshWallet();
            return;
        }
        throw new Error("The returned Phantom action is not recognized.");
    } catch (error) {
        console.error("Phantom mobile callback could not be completed.", error);
        if (state?.session) {
            setPhantomMobilePendingAction(window, { action: "connected" });
        } else {
            clearPhantomMobileSession(window);
        }
        if (broadcastSignature) {
            document.getElementById("deposit-signature").value = broadcastSignature;
            setWalletMessage(`Transaction was submitted, but credit verification did not complete. Keep the signature and use VERIFY & CREDIT. ${error.message}`, "error");
        } else {
            setWalletMessage(`Phantom returned to RelicGrid, but the requested action did not complete. ${error.message}`, "error");
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

function beginGameIntro() {
    introVideo.pause();
    introVideo.hidden = true;
    transitionVideo.hidden = false;
    transitionVideo.src = "gamevideo.mp4";
    transitionVideo.currentTime = 0;
    transitionVideo.muted = false;
    videoSkip.hidden = !player.watchedGameIntro;
    videoSkip.onclick = () => {
        transitionVideo.pause();
        transitionVideo.hidden = true;
        videoSkip.hidden = true;
        showNameOrHome();
    };
    transitionVideo.onended = () => {
        player.watchedGameIntro = true;
        savePlayer();
        videoSkip.hidden = true;
        videoCaption.textContent = "Welcome, pilot.";
        videoAction.textContent = "CONTINUE  →";
        videoAction.hidden = false;
        videoAction.onclick = () => {
            transitionVideo.pause();
            transitionVideo.hidden = true;
            introVideo.hidden = false;
            videoAction.hidden = true;
            showNameOrHome();
        };
    };
    transitionVideo.onerror = () => {
        console.error("Gameplay introduction video could not be decoded.", transitionVideo.error);
        videoCaption.textContent = "This browser could not play the introduction video.";
        videoAction.textContent = "CONTINUE WITHOUT VIDEO  →";
        videoAction.hidden = false;
        videoAction.onclick = () => {
            transitionVideo.hidden = true;
            videoSkip.hidden = true;
            showNameOrHome();
        };
    };
    videoAction.hidden = true;
    videoCaption.textContent = "Initializing your first mission…";
    const playback = transitionVideo.play();
    if (playback && typeof playback.then === "function") {
        playback.then(() => {
            videoCaption.textContent = "Gameplay transmission online · audio enabled.";
        }).catch((error) => {
            if (error.name === "AbortError" && transitionVideo.paused) return;
            console.warn("Gameplay introduction video could not start.", error);
            videoCaption.textContent = "Tap to play the gameplay introduction with sound.";
            videoAction.textContent = "PLAY VIDEO WITH SOUND  →";
            videoAction.hidden = false;
            videoAction.onclick = () => {
                const retry = transitionVideo.play();
                if (retry && typeof retry.then === "function") {
                    retry.then(() => {
                        videoAction.hidden = true;
                        videoCaption.textContent = "Gameplay transmission online · audio enabled.";
                    }).catch((retryError) => {
                        console.error("Gameplay introduction video could not start after interaction.", retryError);
                        videoCaption.textContent = "The gameplay introduction could not be played.";
                        videoAction.textContent = "CONTINUE WITHOUT VIDEO  →";
                        videoAction.hidden = false;
                        videoAction.onclick = () => {
                            transitionVideo.hidden = true;
                            videoSkip.hidden = true;
                            showNameOrHome();
                        };
                    });
                }
            };
        });
    }
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
    showScreen("video-screen");
    transitionVideo.hidden = true;
    introVideo.hidden = false;
    introVideo.muted = false;
    videoSkip.hidden = true;
    videoSkip.onclick = () => {
        introVideo.pause();
        transitionVideo.pause();
        introVideo.hidden = true;
        transitionVideo.hidden = true;
        videoSkip.hidden = true;
        showNameOrHome();
    };
    introFinished = false;
    videoAction.hidden = true;
    videoCaption.textContent = "A new signal is waiting.";
    introVideo.onended = () => {
        introFinished = true;
        videoCaption.textContent = player.watchedGameIntro
            ? "Welcome back, pilot."
            : "Your first signal is ready.";
        videoAction.textContent = "PLAY NOW  →";
        videoAction.hidden = false;
        videoAction.onclick = continueAfterIntro;
        videoSkip.hidden = !player.watchedGameIntro;
    };
    introVideo.onerror = () => {
        console.error("Opening introduction video could not be decoded.", introVideo.error);
        videoCaption.textContent = "This browser could not play the opening video.";
        videoAction.textContent = "CONTINUE WITHOUT VIDEO  →";
        videoAction.hidden = false;
        videoAction.onclick = continueAfterIntro;
    };
    const playback = introVideo.play();
    if (playback && typeof playback.catch === "function") {
        playback.catch((error) => {
            console.warn("Opening introduction video could not autoplay.", error);
            videoCaption.textContent = "Tap to play the opening transmission with sound.";
            videoAction.textContent = "PLAY INTRO WITH SOUND  →";
            videoAction.hidden = false;
            videoAction.onclick = () => {
                const retry = introVideo.play();
                if (retry && typeof retry.then === "function") {
                    retry.then(() => {
                        videoCaption.textContent = "Opening transmission online · audio enabled.";
                        videoAction.hidden = true;
                    }).catch((retryError) => {
                        console.error("Opening introduction video could not start after interaction.", retryError);
                        videoCaption.textContent = "The opening video could not be played.";
                    });
                }
            };
        });
    }
}

async function startLevel(number, resumeMusic = false) {
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
    startLevel(number, true);
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
document.getElementById("fund-account-button").addEventListener("click", () => {
    document.getElementById("wallet-api-status").scrollIntoView({ behavior: "smooth", block: "center" });
    document.getElementById("wallet-api-status").focus({ preventScroll: true });
    const connectedWallet = getConnectedPhantomWallet(window);
    if (connectedWallet &&
        connectedWallet.publicKey === walletStatusSnapshot?.linkedWalletAddress &&
        walletStatusSnapshot?.depositsEnabled === true) {
        document.getElementById("wallet-transfer-amount").focus({ preventScroll: true });
        setWalletMessage("Phantom is connected to the same wallet linked to this game account. Enter an amount and choose DEPOSIT CYFUR to review the transaction in Phantom.", "ready");
    } else {
        void connectSolanaWallet();
    }
});
document.getElementById("wallet-transfer-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void sendCyfurDeposit();
});
document.getElementById("wallet-copy-address").addEventListener("click", async () => {
    const address = document.getElementById("wallet-address").textContent.trim();
    if (!address || address === "Not configured") {
        setWalletMessage("The owner-controlled treasury is not configured. Do not send tokens.", "disabled");
        return;
    }
    try {
        await navigator.clipboard.writeText(address);
        const depositsReady = document.getElementById("wallet-status-value").textContent.startsWith("READY");
        setWalletMessage(
            depositsReady
                ? "Treasury copied. Send only the approved CYFUR mint from the linked wallet."
                : "Treasury address copied for setup only. Deposit verification is not READY; do not send CYFUR.",
            depositsReady ? "ready" : "disabled"
        );
    } catch (error) {
        console.error("Deposit address could not be copied.", error);
        setWalletMessage(`Address copy failed. Select and copy it manually. ${error.message}`, "error");
    }
});
document.getElementById("deposit-signature-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("deposit-signature");
    const button = document.getElementById("deposit-verify-button");
    const signature = input.value.trim();
    if (!signature) return;
    button.disabled = true;
    button.textContent = "VERIFYING…";
    setWalletMessage("Checking transaction status, token mint, recipient, and finality with the backend…", "pending");
    try {
        await verifyDepositSignature(signature);
    } catch (error) {
        console.error("Deposit signature verification failed.", error);
        setWalletMessage(error.message, "error");
    } finally {
        button.disabled = document.getElementById("wallet-status-value").textContent.startsWith("READY") === false;
        button.textContent = "VERIFY & CREDIT";
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
    const response = await fetch("/api/level-completion", {
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

window.addEventListener("fluxgrid:level-timer-start", (event) => {
    const sessionId = event.detail?.walletSessionId;
    if (!sessionId || sessionId !== activeWalletLevelSessionId) return;
    walletTimerStartPromise = (async () => {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        const accessToken = data.session?.access_token;
        if (!accessToken) throw new Error("Player authentication expired before the timer started.");
        const response = await fetch("/api/level-session", {
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
});

backendReady = initializeBackend();
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
