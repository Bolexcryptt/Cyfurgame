import {
    CYFUR_CREDITS_PER_TOKEN,
    LEVEL_TRANSITION_MILESTONES,
    formatCyfurCredits,
    getCampaignStartLevel,
    getLevelEconomy,
    getPendingLevelTransition,
    mergeCompletedLevels,
    levels
} from "./levels.js";
import { supabase, supabaseConfigured } from "./supabase.js";
import { GAME_API_BASE_URL } from "./supabase-config.js";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { ScreenOrientation } from "@capacitor/screen-orientation";
import { StatusBar } from "@capacitor/status-bar";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
    requestAccountEmailLink,
    requestExistingAccountRecovery,
    hydratePlayerFromAuthenticatedAccount,
    isAccountEmailConfirmationCallback,
    restoreOrCreatePlayerSession,
    verifyAccountEmailLink,
    verifyExistingAccountRecovery
} from "./player-auth.mjs";
import {
    bytesToWalletBase64,
    clearPhantomMobileSession,
    connectPhantom,
    decodeWalletBytes,
    decryptPhantomMobileResponse,
    encodeWalletBytes,
    getConnectedPhantomWallet,
    getDepositPreparationFieldErrors,
    getDepositVerificationErrorMessage,
    getFeePayerPreflightError,
    getPhantomProvider,
    getSolFundingStatus,
    isLinkedPhantomWallet,
    isMobileBrowser,
    normalizeDepositSignatureInput,
    readPhantomMobileCallback,
    rebuildMobileDepositAfterBlockhashRejection,
    savePhantomMobileSession,
    signAndBroadcastWithBlockhashRetry,
    setNativePhantomCallback,
    setPhantomMobilePendingAction,
    startPhantomMobileConnect
} from "./wallet-provider.mjs";

const storageKey = "fluxgrid.player.v1";
const accountEmailConfirmationCallback = isAccountEmailConfirmationCallback(window.location);
const ImmersiveMode = registerPlugin("ImmersiveMode");
const screens = [
    "video-screen",
    "name-screen",
    "home-screen",
    "leaderboard-screen",
    "profile-screen",
    "play-screen"
].map((id) => document.getElementById(id));
const introVideo = document.getElementById("intro-video");
introVideo.src = "gamevideo.mp4";
const transitionVideo = document.getElementById("transition-video");
const videoScreen = document.getElementById("video-screen");
const videoAction = document.getElementById("video-action-button");
const videoSkip = document.getElementById("video-skip-button");
const rotateDevicePrompt = document.getElementById("rotate-device-prompt");
const videoCaption = document.getElementById("video-caption");
const backgroundMusic = document.getElementById("background-music");
backgroundMusic.src = "music.mp3";
const playerNameInput = document.getElementById("player-name");
document.getElementById("wallet-exchange-rate").textContent =
    `1 CYFUR = ${CYFUR_CREDITS_PER_TOKEN.toLocaleString("en-US")} CREDITS`;

function apiUrl(path) {
    if (!Capacitor.isNativePlatform()) return `/api/${path}`;
    if (!GAME_API_BASE_URL) {
        throw new Error("GAME_API_BASE_URL must be set for the native app.");
    }
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

function clearAccountEmailCallbackUrl() {
    const callbackUrl = new URL(window.location.href);
    callbackUrl.searchParams.delete("auth");
    callbackUrl.hash = "";
    window.history.replaceState(null, "", callbackUrl.pathname + callbackUrl.search);
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
            transitionMilestonesPlayed: [],
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
            transitionMilestonesPlayed: Array.isArray(parsed.transitionMilestonesPlayed)
                ? [...new Set(parsed.transitionMilestonesPlayed.filter((milestone) =>
                    Number.isInteger(milestone) &&
                    milestone >= LEVEL_TRANSITION_MILESTONES[0] &&
                    milestone <= 98))]
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
            transitionMilestonesPlayed: [],
            lastLevel: 1
        };
    }
}

let player = readPlayer();
let serverGamePoints = "0";
let serverGamePointsVerified = false;
let serverGamePointCompletions = [];
let activeVideoPlayback = null;
let transitionInProgress = false;
let openingFlowFinished = false;
let openingVideoSequence = 0;
let activeOpeningVideoSource = null;
let pendingLevel = null;
let activeWalletLevelSessionId = null;
let walletTimerStartPromise = Promise.resolve(false);
const pendingLevelEntryRequests = new Map();
let levelEntryRequestInProgress = false;
let depositVerificationInProgress = false;
let musicStarted = false;
let authUser = null;
let backendStatus = supabaseConfigured ? "Connecting to RelicGrid…" : "RelicGrid account service is not configured.";
let backendReady;
let walletStatusSnapshot = null;
let levelsGloballyLocked = true;
let activeLevelEntryCostCredits = null;
let levelStartInProgress = false;
let withdrawalSystemReady = false;
let withdrawalAvailableCredits = "0";
let withdrawalHasActiveRequest = false;
let pendingAccountEmail = "";
let pendingAccountRecoveryPlayerId = null;
let pendingPhantomMobileCallback = null;

function savePlayer() {
    localStorage.setItem(storageKey, JSON.stringify(player));
}

async function refreshServerGamePoints() {
    serverGamePointsVerified = false;
    if (!authUser || !supabaseConfigured || !supabase) {
        serverGamePointCompletions = [];
        renderLevels();
        return false;
    }

    const headers = await getWalletAuthorizationHeaders();
    const response = await fetch(apiUrl("game-points"), {
        headers,
        cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok ||
        !/^\d+$/.test(String(result.balancePoints)) ||
        !Array.isArray(result.completedLevels)) {
        throw new Error(result.error || `Server game points could not be loaded (${response.status}).`);
    }

    serverGamePoints = String(result.balancePoints);
    serverGamePointCompletions = [...new Set(result.completedLevels
        .map(Number)
        .filter((levelNumber) => Number.isInteger(levelNumber) && levelNumber >= 1 && levelNumber <= 99))];
    serverGamePointsVerified = true;
    renderLevels();
    return true;
}

async function restorePortraitOrientation() {
    if (!Capacitor.isNativePlatform()) return true;
    try {
        if (Capacitor.getPlatform() === "android") {
            await ImmersiveMode.setEnabled({ enabled: true });
            await StatusBar.hide();
        }
        await ScreenOrientation.lock({ orientation: "portrait" });
        await waitForNativeOrientation("portrait");
        return true;
    } catch (error) {
        console.error("Native portrait orientation could not be restored.", error);
        return false;
    }
}

async function waitForNativeOrientation(expectedOrientation) {
    if (!Capacitor.isNativePlatform()) return;
    const deadline = Date.now() + 5_000;
    let currentOrientation = "unknown";
    while (Date.now() < deadline) {
        const result = await ScreenOrientation.orientation();
        currentOrientation = result.type;
        if (currentOrientation.startsWith(expectedOrientation)) {
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Native screen did not enter ${expectedOrientation} orientation (reported ${currentOrientation}).`);
}

async function stopVideoPlayback(video) {
    if (activeVideoPlayback && activeVideoPlayback.video !== video) return true;
    video.pause();
    if (activeVideoPlayback?.video === video) activeVideoPlayback = null;
    rotateDevicePrompt.hidden = true;
    delete videoScreen.dataset.orientationBlocked;
    return restorePortraitOrientation();
}

async function failActiveVideoPlayback(video, error) {
    const active = activeVideoPlayback;
    if (active?.video !== video || active.failed) return;
    active.failed = true;
    await stopVideoPlayback(video);
    active.onError(error);
}

function attemptActiveVideoPlayback() {
    const active = activeVideoPlayback;
    if (!active || (active.orientation === "landscape" && videoOrientationQuery.matches)) return;
    try {
        const playback = active.video.play();
        if (playback && typeof playback.catch === "function") {
            void playback.then(() => {
                if (activeVideoPlayback !== active || active.playbackStarted) return;
                active.playbackStarted = true;
                active.onPlaybackStarted?.();
            }, (error) => {
                if (activeVideoPlayback !== active ||
                    (error.name === "AbortError" && active.video.paused)) return;
                void failActiveVideoPlayback(active.video, error);
            });
        }
    } catch (error) {
        failActiveVideoPlayback(active.video, error);
    }
}

const videoOrientationQuery = window.matchMedia("(max-width: 900px) and (orientation: portrait)");

function updateVideoOrientation() {
    const active = activeVideoPlayback;
    if (!active) return;
    fitVideoFrame(active.video);
    const nativeOrientationConfirmed = Capacitor.isNativePlatform() &&
        active.nativeOrientationConfirmed === true;
    if (active.orientation === "landscape" &&
        videoOrientationQuery.matches &&
        !nativeOrientationConfirmed) {
        active.video.pause();
        videoScreen.dataset.orientationBlocked = "true";
        rotateDevicePrompt.hidden = false;
        return;
    }
    rotateDevicePrompt.hidden = true;
    delete videoScreen.dataset.orientationBlocked;
    if (active.video.paused) attemptActiveVideoPlayback();
}

async function playVideoInOrientation(video, onError, onPlaybackStarted, orientation = "portrait") {
    const active = {
        video,
        onError,
        onPlaybackStarted,
        orientation,
        playbackStarted: false,
        failed: false,
        nativeOrientationConfirmed: false
    };
    activeVideoPlayback = active;
    video.onerror = () => failActiveVideoPlayback(
        video,
        video.error || new Error("Video could not be decoded.")
    );
    try {
        if (Capacitor.isNativePlatform()) {
            if (Capacitor.getPlatform() === "android") {
                await ImmersiveMode.setEnabled({ enabled: true });
            }
            await ScreenOrientation.lock({ orientation });
            await waitForNativeOrientation(orientation);
            active.nativeOrientationConfirmed = true;
        }
    } catch (error) {
        await failActiveVideoPlayback(video, error);
        return;
    }
    if (activeVideoPlayback !== active) return;
    updateVideoOrientation();
}

videoOrientationQuery.addEventListener("change", updateVideoOrientation);
window.addEventListener("resize", updateVideoOrientation);
window.screen.orientation?.addEventListener("change", updateVideoOrientation);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && activeVideoPlayback) {
        void failActiveVideoPlayback(
            activeVideoPlayback.video,
            new Error("Video playback was interrupted when the app was backgrounded.")
        );
    }
});
if (Capacitor.isNativePlatform()) {
    void App.addListener("appStateChange", ({ isActive }) => {
        if (!isActive && activeVideoPlayback) {
            void failActiveVideoPlayback(
                activeVideoPlayback.video,
                new Error("Video playback was interrupted when the app was backgrounded.")
            );
        }
    }).catch((error) => console.error("Native video interruption listener could not be registered.", error));
    void App.addListener("backButton", ({ canGoBack }) => {
        if (!openingFlowFinished) return;
        if (canGoBack) {
            window.history.back();
        } else {
            void App.minimizeApp().catch((error) => {
                console.error("The app could not be minimized from the back button.", error);
            });
        }
    }).catch((error) => console.error("Native back-button handler could not be registered.", error));
}
document.addEventListener("keydown", (event) => {
    if (openingFlowFinished) return;
    if (["Backspace", "Escape", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
}, true);

function getContinueLevel() {
    return getCampaignStartLevel(player.completedLevels, player.lastLevel, player.unlockedLevel);
}

async function refreshOwnProgress() {
    const { data, error } = await supabase
        .from("level_completions")
        .select("level_number")
        .eq("player_id", authUser.id);
    if (error) throw error;
    let serverGameLevels = [];
    try {
        await refreshServerGamePoints();
        serverGameLevels = serverGamePointCompletions;
    } catch (gamePointsError) {
        serverGamePointsVerified = false;
        serverGamePointCompletions = [];
        console.error("Server game-points balance or progress could not be loaded.", gamePointsError);
    }
    const hydrated = hydratePlayerFromAuthenticatedAccount(
        player,
        authUser,
        { display_name: player.name },
        mergeCompletedLevels(
            player.completedLevels,
            [...data.map((record) => record.level_number), ...serverGameLevels],
            !player.playerId || player.playerId === authUser.id
        )
    );
    Object.assign(player, hydrated);
    savePlayer();
}

async function initializeBackend() {
    if (!supabaseConfigured) {
        renderProfile();
        return false;
    }

    try {
        const session = await restoreOrCreatePlayerSession(supabase.auth);
        authUser = session.user;

        const { data: profile, error: profileError } = await supabase
            .from("player_profiles")
            .select("display_name")
            .eq("id", authUser.id)
            .maybeSingle();
        if (profileError) throw profileError;
        if (!profile) throw new Error("Your RelicGrid player profile is unavailable. Please try again or contact support.");

        if (!profile.display_name && player.playerId === authUser.id && player.name) {
            const { error } = await supabase.rpc("set_player_display_name", {
                p_display_name: player.name
            });
            if (error) throw error;
        }

        Object.assign(player, hydratePlayerFromAuthenticatedAccount(
            player,
            authUser,
            profile,
            []
        ));
        await refreshOwnProgress();
        backendStatus = "Connected to the RelicGrid leaderboard.";
        savePlayer();
        renderProfile();
        if (accountEmailConfirmationCallback) {
            const confirmed = Boolean(authUser.email_confirmed_at);
            setAccountAuthStatus(
                "account-upgrade-status",
                confirmed
                    ? "Recovery email confirmed. This player keeps the same ID, credits, progress, and linked wallet."
                    : "This email link did not confirm the recovery email. Request a fresh email and use its confirmation link or six-digit code.",
                confirmed ? "ready" : "error"
            );
            clearAccountEmailCallbackUrl();
        }
        return true;
    } catch (error) {
        if (accountEmailConfirmationCallback) {
            setAccountAuthStatus(
                "account-upgrade-status",
                "The recovery email could not be confirmed. Request a fresh RelicGrid confirmation email.",
                "error"
            );
            clearAccountEmailCallbackUrl();
        }
        console.error("RelicGrid player initialization failed.", error);
        backendStatus = `RelicGrid connection failed: ${error.message}`;
        renderProfile();
        return false;
    }
}

function showScreen(id) {
    for (const screen of screens) screen.hidden = screen.id !== id;
}

function stopMusic() {
    pauseMusic();
    backgroundMusic.currentTime = 0;
    musicStarted = false;
}

function pauseMusic() {
    backgroundMusic.pause();
    if (musicRetryHandler) {
        document.removeEventListener("pointerdown", musicRetryHandler, true);
        document.removeEventListener("keydown", musicRetryHandler, true);
        musicRetryHandler = null;
    }
}

let musicRetryHandler = null;

function startMusic() {
    if (musicStarted && !backgroundMusic.paused) return;
    musicStarted = true;
    backgroundMusic.muted = false;
    const playback = backgroundMusic.play();
    if (playback && typeof playback.catch === "function") {
        playback.catch((error) => {
            console.warn("Background music could not start.", error);
            musicStarted = false;
            const status = document.getElementById("game-status");
            if (status) status.textContent = "Tap anywhere in the game to enable music.";
            if (!musicRetryHandler) {
                musicRetryHandler = () => {
                    if (document.getElementById("play-screen").hidden) return;
                    document.removeEventListener("pointerdown", musicRetryHandler, true);
                    document.removeEventListener("keydown", musicRetryHandler, true);
                    musicRetryHandler = null;
                    startMusic();
                };
                document.addEventListener("pointerdown", musicRetryHandler, true);
                document.addEventListener("keydown", musicRetryHandler, true);
            }
        });
    }
}

function renderProfile() {
    const completed = player.completedLevels.length;
    const name = player.name || "Pilot";
    const continueLevel = getContinueLevel();
    document.getElementById("profile-name").textContent = name;
    document.getElementById("profile-initial").textContent = name.slice(0, 1).toUpperCase();
    document.getElementById("profile-progress").textContent = `${completed} / 99 cleared`;
    document.getElementById("hero-campaign-status").textContent = `${completed} / 99 CLEARED`;
    document.getElementById("hero-cleared-count").textContent = `${completed} / 99`;
    document.getElementById("hero-unlocked-count").textContent =
        `${String(continueLevel).padStart(2, "0")} / 99`;
    const clearedProgress = Math.min(100, completed / 99 * 100);
    const nextProgress = Math.min(100, continueLevel / 99 * 100);
    document.getElementById("hero-cleared-fill").style.width = `${clearedProgress}%`;
    document.getElementById("hero-unlocked-fill").style.width = `${nextProgress}%`;
    document.getElementById("hero-telemetry-cleared").textContent = `${completed} / 99`;
    document.getElementById("hero-telemetry-next").textContent =
        `${String(continueLevel).padStart(2, "0")} / 99`;
    const clearedTelemetry = document.getElementById("hero-telemetry-cleared-fill");
    const nextTelemetry = document.getElementById("hero-telemetry-next-fill");
    clearedTelemetry.style.width = `${clearedProgress}%`;
    nextTelemetry.style.width = `${nextProgress}%`;
    clearedTelemetry.parentElement.setAttribute("aria-valuenow", String(Math.round(clearedProgress)));
    nextTelemetry.parentElement.setAttribute("aria-valuenow", String(Math.round(nextProgress)));
    document.getElementById("hero-current-sector").textContent =
        `LEVEL ${String(continueLevel).padStart(2, "0")}`;
    document.getElementById("hero-sector-access").textContent = levelsGloballyLocked
        ? "ALL SECTORS LOCKED"
        : "WALLET CREDITS REQUIRED";
    document.getElementById("continue-game").disabled = levelsGloballyLocked;
    const campaignMap = document.getElementById("campaign-map-grid");
    const campaignMapCells = document.createDocumentFragment();
    for (const level of levels) {
        const cell = document.createElement("span");
        const completedLevel = player.completedLevels.includes(level.number);
        const currentLevel = level.number === continueLevel && !completedLevel;
        cell.className = `campaign-map-cell${completedLevel ? " is-cleared" : ""}${currentLevel ? " is-current" : ""}`;
        cell.title = `Sector ${String(level.number).padStart(2, "0")}: ${
            completedLevel ? "cleared" : currentLevel ? "next sector" : "available"
        }`;
        cell.setAttribute("aria-hidden", "true");
        campaignMapCells.append(cell);
    }
    campaignMap.replaceChildren(campaignMapCells);
    document.getElementById("campaign-progress").textContent =
        `${String(completed).padStart(2, "0")} / 99`;
    const progressFill = document.getElementById("campaign-progress-fill");
    if (progressFill) {
        progressFill.style.width = `${Math.min(100, completed / 99 * 100)}%`;
    }
    const nextLevel = levels[continueLevel - 1];
    const nextLevelLabel = document.getElementById("hero-next-level");
    if (nextLevelLabel) {
        nextLevelLabel.textContent = nextLevel
            ? `LEVEL ${String(nextLevel.number).padStart(2, "0")} / 99`
            : "CAMPAIGN COMPLETE";
    }

    const profileDetails = document.getElementById("profile-details");
    profileDetails.replaceChildren(
        statCard("CALLSIGN", name),
        statCard("PLAYER ID", player.playerId || "Available after account setup"),
        statCard("LEVELS COMPLETED", `${completed} / 99`),
        statCard("NEXT STORY LEVEL", `LEVEL ${String(player.unlockedLevel).padStart(2, "0")}`),
        statCard("LEADERBOARD", supabaseConfigured ? backendStatus : "RelicGrid account service is unavailable")
    );
    renderPlayerAccountStatus();
    renderWalletAccountProtection();
}

function renderWalletAccountProtection() {
    const panel = document.getElementById("wallet-account-protection");
    if (panel) panel.hidden = !supabaseConfigured || authUser?.is_anonymous !== true;
}

function renderPlayerAccountStatus() {
    const status = document.getElementById("account-identity-status");
    const linkForm = document.getElementById("account-upgrade-form");
    const verifyForm = document.getElementById("account-upgrade-code-form");
    const recoveryPanel = document.getElementById("account-recovery-panel");
    if (!status) return;

    if (!supabaseConfigured || !authUser) {
        status.textContent = "RelicGrid player sign-in is unavailable.";
        if (linkForm) linkForm.hidden = true;
        if (verifyForm) verifyForm.hidden = true;
        if (recoveryPanel) recoveryPanel.hidden = true;
        return;
    }

    const isAnonymous = authUser.is_anonymous === true;
    if (isAnonymous) {
        status.textContent = "This identity survives normal app updates, but uninstalling can remove its saved session. Link and verify a recovery email before reinstalling to restore this same player ID.";
        if (linkForm) linkForm.hidden = false;
        if (verifyForm) verifyForm.hidden = !pendingAccountEmail;
    } else {
        status.textContent = authUser.email_confirmed_at
            ? "A verified sign-in identity is linked to this player. Credits, progress, and wallet links remain attached to the same RelicGrid player ID."
            : "A permanent sign-in identity is linked to this player. Verify its email to enable account recovery.";
        if (linkForm) linkForm.hidden = true;
        if (verifyForm) verifyForm.hidden = true;
    }
    if (recoveryPanel) recoveryPanel.hidden = !isAnonymous;
}

async function requestAccountRecoveryPreflight() {
    if (!supabaseConfigured || !supabase || !authUser ||
        authUser.is_anonymous !== true) {
        throw new Error("Account recovery requires the current anonymous player session.");
    }
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (!data.session?.access_token || data.session.user?.id !== authUser.id) {
        throw new Error("The current RelicGrid player session could not be verified.");
    }

    const response = await fetch(apiUrl("wallet?action=identity-recovery-preflight"), {
        headers: {
            Authorization: `Bearer ${data.session.access_token}`,
            "Content-Type": "application/json"
        },
        cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.message || result.error ||
            `Account recovery check failed (${response.status}).`);
    }
    if (result.safeToRecover !== true) {
        throw new Error(result.message ||
            "The current player identity could not be proven safe to replace.");
    }
}

function setAccountAuthStatus(elementId, message, state = "") {
    const status = document.getElementById(elementId);
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
}

async function requestAccountUpgrade(event) {
    event.preventDefault();
    const email = document.getElementById("account-upgrade-email").value.trim();
    setAccountAuthStatus("account-upgrade-status", "Requesting an email verification code…", "pending");
    try {
        await backendReady;
        if (!authUser || authUser.is_anonymous !== true) {
            throw new Error("Only the current anonymous player can be upgraded.");
        }
        const emailRedirectTo = new URL("/?auth=email-confirmed", GAME_API_BASE_URL).toString();
        await requestAccountEmailLink(supabase.auth, email, emailRedirectTo);
        pendingAccountEmail = email;
        document.getElementById("account-upgrade-code-form").hidden = false;
        renderPlayerAccountStatus();
        setAccountAuthStatus(
            "account-upgrade-status",
            "Check your email for the RelicGrid confirmation link or six-digit code. The player ID and existing data are unchanged.",
            "pending"
        );
    } catch (error) {
        console.error("Player account email could not be linked.", error);
        setAccountAuthStatus("account-upgrade-status", error.message, "error");
    }
}

async function verifyAccountUpgrade(event) {
    event.preventDefault();
    const email = document.getElementById("account-upgrade-email").value.trim();
    const token = document.getElementById("account-upgrade-code").value.trim();
    setAccountAuthStatus("account-upgrade-status", "Verifying the email identity…", "pending");
    try {
        if (!authUser || authUser.is_anonymous !== true || !pendingAccountEmail ||
            email.toLowerCase() !== pendingAccountEmail.toLowerCase()) {
            throw new Error("Request a new email verification code for the current player account.");
        }
        const verifiedUser = await verifyAccountEmailLink(supabase.auth, email, token);
        if (verifiedUser.id !== authUser.id) {
            throw new Error("The verification did not match the current player identity.");
        }
        const { data, error } = await supabase.auth.getUser();
        if (error) throw error;
        authUser = data.user;
        pendingAccountEmail = "";
        renderProfile();
        setAccountAuthStatus(
            "account-upgrade-status",
            "Recovery email verified. This account keeps the same player ID, balances, progress, and linked wallet.",
            "ready"
        );
    } catch (error) {
        console.error("Player account email verification failed.", error);
        setAccountAuthStatus("account-upgrade-status", error.message, "error");
    }
}

async function requestAccountRecovery(event) {
    event.preventDefault();
    const email = document.getElementById("account-recovery-email").value.trim();
    pendingAccountRecoveryPlayerId = null;
    setAccountAuthStatus("account-recovery-status", "Checking this guest account before recovery…", "pending");
    try {
        await backendReady;
        await requestAccountRecoveryPreflight();
        await requestExistingAccountRecovery(supabase.auth, email);
        pendingAccountRecoveryPlayerId = authUser.id;
        setAccountAuthStatus(
            "account-recovery-status",
            "If this email has a linked player account, RelicGrid sent a sign-in code. Enter it below. No new permanent account is created.",
            "pending"
        );
        document.getElementById("account-recovery-code-form").hidden = false;
    } catch (error) {
        console.error("Existing player account recovery could not be started.", error);
        setAccountAuthStatus("account-recovery-status", error.message, "error");
    }
}

async function verifyAccountRecovery(event) {
    event.preventDefault();
    const email = document.getElementById("account-recovery-email").value.trim();
    const token = document.getElementById("account-recovery-code").value.trim();
    setAccountAuthStatus("account-recovery-status", "Verifying the existing player account…", "pending");
    try {
        if (!authUser || authUser.is_anonymous !== true ||
            pendingAccountRecoveryPlayerId !== authUser.id) {
            throw new Error("Request a new sign-in code for this guest account before restoring another player.");
        }
        const recoveredUser = await verifyExistingAccountRecovery(supabase.auth, email, token);
        pendingAccountRecoveryPlayerId = null;
        authUser = recoveredUser;
        pendingAccountEmail = "";
        player.name = "";
        player.playerId = recoveredUser.id;
        player.completedLevels = [];
        player.unlockedLevel = 1;
        player.lastLevel = 1;
        player.transitionMilestonesPlayed = [];
        const { data: profile, error } = await supabase
            .from("player_profiles")
            .select("display_name")
            .eq("id", recoveredUser.id)
            .maybeSingle();
        if (error) throw error;
        if (!profile) throw new Error("The recovered player profile could not be loaded.");
        player.name = profile.display_name || "";
        await refreshOwnProgress();
        savePlayer();
        backendReady = Promise.resolve(true);
        renderProfile();
        await refreshWallet();
        await refreshServerGamePoints();
        await refreshWithdrawalStatus();
        showNameOrHome();
        setAccountAuthStatus(
            "account-recovery-status",
            "Existing player account restored. Its profile and saved campaign progress are loaded under the original player ID.",
            "ready"
        );
    } catch (error) {
        console.error("Existing player account recovery failed.", error);
        setAccountAuthStatus("account-recovery-status", error.message, "error");
    }
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
        setLeaderboardStatus("The RelicGrid account service is not configured. Shared rankings are unavailable.", "error");
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
    setLeaderboardStatus(`${data.length} player${data.length === 1 ? "" : "s"} loaded from RelicGrid.`);
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
        const entryCostCredits = getLevelEconomy(level.number).entryCostCredits;
        const walletBalance = walletStatusSnapshot?.balanceCredits;
        const hasVerifiedWalletBalance = walletStatusSnapshot?.balanceVerified === true &&
            /^\d+$/.test(String(walletBalance));
        const paidGameplayEnabled = walletStatusSnapshot?.paidGameplayEnabled === true;
        const hasWalletEntryCredits = paidGameplayEnabled &&
            hasVerifiedWalletBalance &&
            BigInt(walletBalance) >= BigInt(entryCostCredits);
        const levelLocked = levelsGloballyLocked;
        button.className =
            `${levelLocked ? "is-locked" : "is-unlocked"}${completed ? " is-complete" : ""}${current ? " is-current" : ""}`;
        button.disabled = levelLocked;
        const entryCost = document.createElement("small");
        entryCost.className = "level-cost";
        entryCost.textContent = hasWalletEntryCredits
            ? `${formatCredits(entryCostCredits)} WALLET CREDITS`
            : paidGameplayEnabled && hasVerifiedWalletBalance
                ? `NEED ${formatCredits(entryCostCredits)} WALLET CREDITS · FREE PRACTICE`
                : paidGameplayEnabled
                    ? "WALLET BALANCE UNVERIFIED"
                    : "PAID ENTRY DISABLED · FREE PRACTICE";
        detail.append(title, meta);
        const badge = document.createElement("span");
        badge.className = "level-state";
        badge.textContent = levelLocked
            ? "LOCKED"
            : hasWalletEntryCredits ? "ACCESS READY" : "FREE PRACTICE";
        const cost = document.createElement("span");
        cost.className = "level-entry-cost";
        cost.append(entryCost);
        button.append(number, detail, cost, badge);
        button.setAttribute("aria-label", levelLocked
            ? `Level ${level.number} is locked`
            : hasWalletEntryCredits
                ? `Play level ${level.number} using ${formatCredits(entryCostCredits)} wallet credits`
                : paidGameplayEnabled
                    ? `Practice level ${level.number}; ${formatCredits(entryCostCredits)} wallet credits are required for paid entry`
                    : `Practice level ${level.number}; paid wallet-credit entry is disabled`);
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
    void refreshGameConfig();
    void refreshWallet();
    void refreshServerGamePoints();
}

async function refreshGameConfig() {
    try {
        const response = await fetch(apiUrl("game-config"), { cache: "no-store" });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || typeof result.levelsLocked !== "boolean") {
            throw new Error(result.error || `Game access status could not be loaded (${response.status}).`);
        }
        levelsGloballyLocked = result.levelsLocked;
    } catch (error) {
        console.error("Game access status could not be loaded.", error);
        levelsGloballyLocked = true;
    }
    renderProfile();
    renderLevels();
    const levelStatus = document.getElementById("level-entry-status");
    if (levelStatus) {
        levelStatus.textContent = levelsGloballyLocked
            ? "All levels are temporarily locked. Your saved progress is unchanged."
            : "Use your authenticated wallet credits to enter campaign levels.";
    }
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

function formatCreditsAsCyfur(value) {
    if (typeof value !== "string" && typeof value !== "number") {
        return "Unavailable";
    }
    return formatCyfurCredits(value);
}

function setLevelEntryMessage(message, state = "disabled") {
    const status = document.getElementById("level-entry-status");
    status.textContent = message;
    status.dataset.state = state;
}

async function requestLevelEntry(levelNumber) {
        if (levelEntryRequestInProgress) return null;
        if (levelsGloballyLocked) {
            setLevelEntryMessage("All levels are temporarily locked. Your saved progress is unchanged.", "disabled");
            return null;
        }
        const practiceEntry = (reason) => {
            setLevelEntryMessage(
                `Level ${levelNumber} started in free practice. ${reason} No credits were charged; progress and rewards will not be saved.`,
                "ready"
            );
            return {
                practice: true,
                sessionId: null,
                balanceCredits: walletStatusSnapshot?.balanceVerified
                    ? String(walletStatusSnapshot.balanceCredits)
                    : "0",
                entryCostCredits: null
            };
        };
        const rejectPaidEntry = (message) => {
            setLevelEntryMessage(message, "error");
            return null;
        };
        if (!supabaseConfigured || !supabase) {
            return practiceEntry("Wallet verification is unavailable.");
        }

        levelEntryRequestInProgress = true;
        setLevelEntryMessage("Checking campaign access and wallet credits with the backend…", "pending");
        try {
            const { data, error } = await supabase.auth.getSession();
            if (error) throw error;
            const accessToken = data.session?.access_token;
            if (!accessToken) {
                return practiceEntry("Sign in to enable verified progress and rewards.");
            }
            const requestStorageKey = `relicgrid.level-entry.${authUser?.id || "player"}.${levelNumber}`;
            const storedRequestId = sessionStorage.getItem(requestStorageKey);
            const requestId = pendingLevelEntryRequests.get(levelNumber) ?? storedRequestId ?? crypto.randomUUID();
            pendingLevelEntryRequests.set(levelNumber, requestId);
            sessionStorage.setItem(requestStorageKey, requestId);

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
            if (!response.ok && response.status < 500) {
                pendingLevelEntryRequests.delete(levelNumber);
                sessionStorage.removeItem(requestStorageKey);
            }

            if (result.balanceVerified === true && /^\d+$/.test(String(result.balanceCredits))) {
                const balance = document.getElementById("wallet-balance");
                balance.textContent = formatCredits(result.balanceCredits);
                document.getElementById("wallet-balance-state").textContent = "CREDITS · BACKEND VERIFIED";
                walletStatusSnapshot = {
                    ...walletStatusSnapshot,
                    balanceCredits: String(result.balanceCredits),
                    balanceVerified: true
                };
                renderLevels();
            }

            if (response.status === 402 && result.error === "insufficient_balance") {
                const balanceMessage = /^\d+$/.test(String(result.balanceCredits))
                    ? `Your verified balance is ${formatCredits(result.balanceCredits)}.`
                    : "Your balance changed while entry was reserved; refresh the wallet and try again.";
                const costMessage = /^\d+$/.test(String(result.entryCostCredits))
                    ? `Level ${levelNumber} requires ${formatCredits(result.entryCostCredits)} credits.`
                    : `Level ${levelNumber} could not be charged.`;
                return rejectPaidEntry(`${costMessage} ${balanceMessage} No level was started.`);
            }
            if (response.status === 409 && result.error === "level_session_active") {
                return rejectPaidEntry("A paid level session is already active. Finish it or wait for it to expire before starting another.");
            }
            if (response.status === 423 && result.error === "levels_locked") {
                levelsGloballyLocked = true;
                renderProfile();
                renderLevels();
                setLevelEntryMessage("All levels are temporarily locked. Your saved progress is unchanged.", "disabled");
                return null;
            }
            if (result.error === "paid_gameplay_disabled") {
                return rejectPaidEntry("Paid level entry is disabled in the backend. No level was started.");
            }
            if (result.error === "wallet_schema_not_installed") {
                return rejectPaidEntry("Wallet database setup is incomplete. No level was started.");
            }
            if (result.error === "wallet_migration_required") {
                return rejectPaidEntry("The wallet level-entry migration is missing or outdated. No level was started.");
            }
            if (result.error === "verified_balance_unavailable") {
                return rejectPaidEntry("The server could not verify your wallet-credit balance. No level was started.");
            }
            if (result.error === "wallet_api_not_configured") {
                return rejectPaidEntry("The wallet API is not configured. No level was started.");
            }
            if (result.error === "authentication_required") {
                return rejectPaidEntry("Your sign-in expired before level entry. Sign in again; no level was started.");
            }
            if (response.status === 404 || response.status === 501) {
                return rejectPaidEntry("This deployment is missing the paid-entry API. No level was started.");
            }
            if (response.ok && result.allowed === true && result.balanceVerified === true &&
                typeof result.sessionId === "string" &&
                /^\d+$/.test(String(result.balanceCredits)) &&
                /^\d+$/.test(String(result.entryCostCredits))) {
                pendingLevelEntryRequests.delete(levelNumber);
                sessionStorage.removeItem(requestStorageKey);
                return result;
            }

            throw new Error(result.error || `Level entry check failed (${response.status}).`);
        } catch (error) {
            console.error("Wallet-credit level entry could not be verified.", error);
            return rejectPaidEntry(
                `Wallet-credit entry could not be verified (${error.message}). No level was started.`
            );
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
                const message = "Opening Phantom's secure connection request. Approve wallet access; RelicGrid will return to this browser without sending tokens.";
                setWalletMessage(message, "pending");
                setWithdrawalLinkStatus(message, "pending");
                startPhantomMobileConnect(window, walletStatusSnapshot?.network);
            } catch (error) {
                setWalletMessage(`Phantom mobile connection could not start. ${error.message}`, "error");
                setWithdrawalLinkStatus(`Phantom mobile connection could not start. ${error.message}`, "error");
            }
        } else {
            const message = "Phantom mobile connection requires the secure production HTTPS site.";
            setWalletMessage(message, "error");
            setWithdrawalLinkStatus(message, "error");
        }
    } else {
        const message = "Phantom is not available to this page. Open RelicGrid in a normal Chrome or Edge tab where the Phantom extension is installed and allowed for this site—not an embedded preview—then reload. No transfer was made.";
        setWalletMessage(message, "error");
        setWithdrawalLinkStatus(message, "error");
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
        const tokenAmount = formatTokenAmount(deposit.amount_raw, deposit.token_decimals);
        const creditedAmount = /^\d+$/.test(String(deposit.credit_amount_credits))
            ? `${formatCredits(String(deposit.credit_amount_credits))} CREDITS`
            : "CREDITS NOT CONFIRMED";
        amount.textContent = `${tokenAmount} CYFUR · ${creditedAmount}`;
        const signature = document.createElement("small");
        const transactionSignature = deposit.transaction_signature;
        if (typeof transactionSignature === "string" &&
            /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(transactionSignature)) {
            const transactionLink = document.createElement("a");
            const solscanUrl = new URL(`https://solscan.io/tx/${encodeURIComponent(transactionSignature)}`);
            if (deposit.network === "devnet") solscanUrl.searchParams.set("cluster", "devnet");
            transactionLink.href = solscanUrl.href;
            transactionLink.target = "_blank";
            transactionLink.rel = "noopener noreferrer";
            transactionLink.textContent = `VIEW TRANSACTION · ${transactionSignature.slice(0, 8)}…${transactionSignature.slice(-8)}`;
            signature.append(transactionLink);
        } else {
            signature.textContent = "Transaction reference unavailable";
        }
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
        const signature = withdrawal.transaction_signature;
        if (typeof signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(signature)) {
            info.textContent = `SIG ${signature.slice(0, 8)}…${signature.slice(-8)} · `;
            const link = document.createElement("a");
            link.href = `https://solscan.io/tx/${encodeURIComponent(signature)}`;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = "VIEW ON SOLSCAN";
            info.append(link);
        } else {
            info.textContent = `Status: ${withdrawal.status || "unknown"}`;
        }
        detail.append(amount, info);

        const state = document.createElement("span");
        state.className = "wallet-history-state";
        const normalized = (withdrawal.status || "unknown").toLowerCase();
        state.dataset.state = ["pending", "submitted", "confirmed", "failed"].includes(normalized)
            ? normalized === "submitted" ? "pending" : normalized
            : "unknown";
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
    const credits = parseWithdrawalCredits(value);
    if (credits === null || credits <= 0n) {
        preview.textContent = "0.00000000 CYFUR";
        return;
    }
    const rawAmount = (credits * 10n ** BigInt(decimals)) / BigInt(CYFUR_CREDITS_PER_TOKEN);
    preview.textContent = `${formatTokenAmount(rawAmount.toString(), decimals)} CYFUR`;
}

function parseWithdrawalCredits(value) {
    const normalized = value.trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(normalized)) return null;
    const [whole, fraction = ""] = normalized.split(".");
    return BigInt(whole) * BigInt(CYFUR_CREDITS_PER_TOKEN) +
        BigInt((fraction + "000").slice(0, 3));
}

function formatWithdrawalCreditsAsCyfur(credits) {
    const amount = BigInt(credits);
    const whole = amount / BigInt(CYFUR_CREDITS_PER_TOKEN);
    const fraction = String(amount % BigInt(CYFUR_CREDITS_PER_TOKEN)).padStart(3, "0");
    return `${whole}.${fraction}`;
}

function updateWithdrawalControls() {
    const address = document.getElementById("withdrawal-wallet-address");
    const amountInput = document.getElementById("withdrawal-amount");
    const maxButton = document.getElementById("withdrawal-max");
    const submit = document.getElementById("withdrawal-submit");
    if (!address || !amountInput || !maxButton || !submit) return;

    const destinationValid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.value.trim());
    const amountCredits = parseWithdrawalCredits(amountInput.value.trim());
    const amountIsValid = amountCredits !== null &&
        amountCredits > 0n &&
        amountCredits <= BigInt(withdrawalAvailableCredits);
    const canWithdraw = withdrawalSystemReady && !withdrawalHasActiveRequest;
    amountInput.disabled = !canWithdraw;
    maxButton.disabled = !canWithdraw || BigInt(withdrawalAvailableCredits) <= 0n;
    submit.disabled = !canWithdraw || !destinationValid || !amountIsValid;
}

async function refreshWithdrawalStatus() {
    const addressInput = document.getElementById("withdrawal-wallet-address");
    const submit = document.getElementById("withdrawal-submit");
    const amountInput = document.getElementById("withdrawal-amount");
    const maxButton = document.getElementById("withdrawal-max");
    const balanceNote = document.getElementById("withdrawal-balance-note");
    const minimumValue = document.getElementById("withdrawal-minimum");
    const minimumNote = document.getElementById("withdrawal-minimum-note");
    const history = document.getElementById("withdrawal-history");
    const tokenDecimals = document.getElementById("withdrawal-token-decimals");
    if (!addressInput || !submit || !amountInput || !maxButton ||
        !balanceNote || !minimumValue || !minimumNote || !history) return;
    withdrawalSystemReady = false;
    withdrawalAvailableCredits = "0";
    withdrawalHasActiveRequest = false;
    setWithdrawalStatus("Loading withdrawal details…", "pending");
    submit.disabled = true;
    maxButton.disabled = true;
    amountInput.disabled = true;
    minimumValue.textContent = "0.001 CYFUR";
    minimumNote.textContent = "1 credit at the current conversion rate; limited to 5 requests per hour.";
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
        const decimals = Number(result.config?.tokenDecimals ?? 8);
        if (tokenDecimals) tokenDecimals.dataset.decimals = String(decimals);
        balanceNote.textContent = result.level30Requirement?.met === true
            ? "Withdrawals use the available balance shown above."
            : `Withdrawals use the available balance shown above; complete levels 1-30 to unlock access (${Number(result.level30Requirement?.completedLevels) || 0}/30).`;
        minimumValue.textContent = "0.001 CYFUR";
        minimumNote.textContent = "1 credit at the current conversion rate; limited to 5 requests per hour.";
        renderWithdrawalHistory(result.withdrawals || []);
        withdrawalSystemReady = result.withdrawalEnabled === true;
        withdrawalAvailableCredits = result.availableCredits || "0";
        withdrawalHasActiveRequest = result.activeWithdrawal === true;
        maxButton.dataset.availableCredits = result.availableCredits || "0";
        updateWithdrawalControls();
        if (withdrawalHasActiveRequest) {
            setWithdrawalStatus("A withdrawal is already pending confirmation. Check the history below; another request is blocked to prevent duplicate payments.", "pending");
            return;
        }
        if (result.level30Requirement?.met !== true) {
            const completedLevels = Number.isInteger(result.level30Requirement?.completedLevels)
                ? result.level30Requirement.completedLevels
                : 0;
            setWithdrawalStatus(
                `Complete levels 1-30 to unlock withdrawals (${completedLevels}/30 server-saved clears).`,
                "disabled"
            );
            return;
        }
        if (!withdrawalSystemReady) {
            setWithdrawalStatus("Withdrawals are temporarily unavailable. Please try again later.", "error");
            return;
        }
        updateWithdrawalPreview();
        setWithdrawalStatus("Paste a valid Solana receiving address and choose an amount up to your available balance.", "ready");
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
    const amountValue = (amountInput.value || "").trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
        setWithdrawalStatus("Paste a valid Solana receiving address before requesting a withdrawal.", "error");
        return;
    }
    const amountCreditsValue = parseWithdrawalCredits(amountValue);
    if (amountCreditsValue === null || amountCreditsValue <= 0n) {
        setWithdrawalStatus("Enter a valid positive CYFUR amount in 0.001 increments.", "error");
        return;
    }
    const amountCredits = amountCreditsValue.toString();
    const requestStorageKey = `relicgrid.withdrawal-request.${authUser?.id || "player"}`;
    let requestData;
    try {
        requestData = JSON.parse(sessionStorage.getItem(requestStorageKey) || "null");
    } catch {
        requestData = null;
    }
    if (!requestData ||
        requestData.walletAddress !== walletAddress ||
        requestData.amountCredits !== amountCredits ||
        typeof requestData.idempotencyKey !== "string") {
        requestData = {
            walletAddress,
            amountCredits,
            idempotencyKey: crypto.randomUUID()
        };
        sessionStorage.setItem(requestStorageKey, JSON.stringify(requestData));
    }
    submitButton.disabled = true;
    setWithdrawalStatus("Submitting withdrawal request to the secure server…", "pending");
    if (statusNode) {
        statusNode.hidden = false;
        statusNode.textContent = "Requesting the on-chain transfer…";
        statusNode.dataset.state = "pending";
    }

    try {
        if (!supabaseConfigured || !supabase) throw new Error("RelicGrid sign-in is unavailable.");
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
            body: JSON.stringify({
                action: "submit",
                walletAddress,
                amountCredits,
                idempotencyKey: requestData.idempotencyKey
            }),
            cache: "no-store"
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            const withdrawalErrors = {
                withdrawal_rate_limited: "You have reached the limit of 5 withdrawal requests in the last hour.",
                withdrawals_disabled: "Withdrawals are temporarily unavailable. Please try again later."
            };
            const errorMessage = result.message ||
                withdrawalErrors[result.error] ||
                result.error ||
                `Withdrawal request failed (${response.status}).`;
            if (["insufficient_balance", "withdrawal_failed"].includes(result.error)) {
                sessionStorage.removeItem(requestStorageKey);
            }
            await refreshWithdrawalStatus();
            setWithdrawalStatus(errorMessage, "error");
            if (statusNode) {
                statusNode.textContent = errorMessage;
                statusNode.dataset.state = "error";
            }
            return;
        }
        if (result.status === "confirmed") {
            sessionStorage.removeItem(requestStorageKey);
            setWithdrawalStatus("Withdrawal confirmed on Solana.", "ready");
            if (statusNode) {
                statusNode.replaceChildren(document.createTextNode("Transaction signature: "));
                const signatureText = document.createElement("span");
                signatureText.textContent = result.signature || "unavailable";
                statusNode.append(signatureText);
                if (typeof result.signature === "string" &&
                    /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(result.signature)) {
                    statusNode.append(document.createTextNode(" · "));
                    const link = document.createElement("a");
                    link.href = `https://solscan.io/tx/${encodeURIComponent(result.signature)}`;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    link.textContent = "VIEW ON SOLSCAN";
                    statusNode.append(link);
                }
                statusNode.dataset.state = "ready";
            }
            await refreshWithdrawalStatus();
            setWithdrawalStatus("Withdrawal confirmed on Solana.", "ready");
            return;
        }
        const pendingMessage = result.signature
            ? `Withdrawal ${result.status || "pending"}. Transaction signature: ${result.signature}`
            : result.message || "The server accepted the request but the final transfer status is pending.";
        setWithdrawalStatus(pendingMessage, "pending");
        if (statusNode) {
            statusNode.replaceChildren(document.createTextNode(pendingMessage));
            if (typeof result.signature === "string" &&
                /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(result.signature)) {
                statusNode.append(document.createTextNode(" · "));
                const link = document.createElement("a");
                link.href = `https://solscan.io/tx/${encodeURIComponent(result.signature)}`;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.textContent = "VIEW ON SOLSCAN";
                statusNode.append(link);
            }
            statusNode.dataset.state = "pending";
        }
        await refreshWithdrawalStatus();
        setWithdrawalStatus(pendingMessage, "pending");
    } catch (error) {
        console.error("Withdrawal submission failed.", error);
        await refreshWithdrawalStatus();
        setWithdrawalStatus(error.message || "The withdrawal request could not be completed.", "error");
        if (statusNode) {
            statusNode.textContent = error.message || "Withdrawal failed.";
            statusNode.dataset.state = "error";
        }
    }
}

async function refreshWallet() {
    const address = document.getElementById("wallet-address");
    const copyButton = document.getElementById("wallet-copy-address");
    const signatureSubmit = document.getElementById("deposit-verify-button");
    const balance = document.getElementById("wallet-balance");
    const balanceState = document.getElementById("wallet-balance-state");
    const status = document.getElementById("wallet-status-value");
    const refreshButton = document.getElementById("wallet-refresh");
    const balanceRefreshButton = document.getElementById("wallet-balance-refresh");
    const walletRequirement = document.getElementById("deposit-wallet-requirement");
    walletStatusSnapshot = null;
    refreshButton.disabled = true;
    refreshButton.textContent = "LOADING";
    balanceRefreshButton.disabled = true;
    balanceRefreshButton.textContent = "CHECKING BALANCE…";
    copyButton.disabled = false;
    status.textContent = "DISABLED";
    status.dataset.state = "disabled";
    balance.textContent = "—";
    balanceState.textContent = "CHECKING ACCOUNT BALANCE…";
    walletRequirement.textContent = "Checking deposit readiness…";
    signatureSubmit.disabled = true;
    renderWalletHistory(null);

    try {
        if (!supabaseConfigured || !supabase) {
            balanceState.textContent = "ACCOUNT SERVICE NOT CONFIGURED";
            walletRequirement.textContent = "Funding cannot start until the account service is configured.";
            setWalletMessage("The account service is not configured. Funding is disabled.", "error");
            return;
        }
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        const accessToken = data.session?.access_token;
        if (!accessToken) {
            balanceState.textContent = "SIGN IN TO VIEW BALANCE";
            walletRequirement.textContent = "Sign in to your RelicGrid account to load your balance and verify a transaction.";
            setWalletMessage("Sign in to view your balance and deposit options. No wallet connection is required.", "error");
            return;
        }

        const response = await fetch(apiUrl("wallet"), {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: "no-store"
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (result.error === "wallet_schema_not_installed") {
                balanceState.textContent = "DATABASE SETUP INCOMPLETE";
                walletRequirement.textContent = "The wallet database migrations must be applied before funding can be used.";
                setWalletMessage(walletRequirement.textContent, "disabled");
                return;
            }
            if (result.error === "wallet_api_not_configured") {
                balanceState.textContent = "SERVER SETUP INCOMPLETE";
                walletRequirement.textContent = "The Vercel wallet API environment is incomplete. Ask the project owner to configure it.";
                setWalletMessage(walletRequirement.textContent, "disabled");
                return;
            }
            if (result.error === "authentication_required") {
                balanceState.textContent = "SIGN-IN EXPIRED";
                walletRequirement.textContent = "Your RelicGrid sign-in expired. Sign in again to load account funding.";
                setWalletMessage(walletRequirement.textContent, "error");
                return;
            }
            if (response.status === 404 || response.status === 501) {
                balanceState.textContent = "WALLET API NOT DEPLOYED";
                walletRequirement.textContent = "The wallet API route is missing from this deployment. Redeploy the current main branch.";
                setWalletMessage(walletRequirement.textContent, "disabled");
                return;
            }
            if (response.status >= 500) {
                throw new Error("The wallet service returned a server error. Try refreshing, or contact the project owner.");
            }
            throw new Error(result.error || `Wallet request failed (${response.status}).`);
        }

        walletStatusSnapshot = result;
        renderLevels();
        const depositConfigurationReady = result.depositsEnabled === true &&
            typeof result.network === "string" &&
            Boolean(result.treasuryAddress) &&
            Boolean(result.officialMintAddress) &&
            Boolean(result.tokenProgramId) &&
            Number.isInteger(result.tokenDecimals) &&
            Boolean(result.treasuryTokenAccountAddress);
        const depositReady = depositConfigurationReady;
        document.getElementById("wallet-network-label").textContent = depositReady
            ? `01 · VERIFIED CYFUR TREASURY · ${result.network.toUpperCase()}`
            : "01 · PUBLIC SHARED CYFUR TREASURY · FUNDING SETUP REQUIRED";
        signatureSubmit.disabled = !depositReady;
        balance.textContent = result.balanceCredits === null
            ? "—"
            : formatCredits(result.balanceCredits);
        balanceState.textContent =
            result.balanceVerified === true
                ? "CREDITS · BACKEND VERIFIED"
                : result.balanceError === "wallet_balance_unavailable"
                    ? "SERVER BALANCE UNAVAILABLE"
                    : "CREDITS · NOT VERIFIED";
        if (result.balanceVerified !== true) balance.textContent = "—";
        status.textContent = depositReady
            ? `READY${result.network ? ` · ${result.network.toUpperCase()}` : ""}`
            : "DISABLED";
        renderWalletHistory(result.deposits);
        if (depositReady) {
            walletRequirement.textContent = "Send CYFUR to the treasury wallet above, then enter the transaction ID here.";
            document.getElementById("deposit-signature").disabled = false;
            signatureSubmit.disabled = false;
        } else {
            const readinessMessage = typeof result.disabledMessage === "string" &&
                result.disabledMessage.trim()
                ? result.disabledMessage
                : "Deposits are temporarily unavailable. Please check back later.";
            walletRequirement.textContent = `Funding is not ready. ${readinessMessage}`;
            setWalletMessage(readinessMessage, "disabled");
        }
        await refreshWithdrawalStatus();
    } catch (error) {
        console.error("Wallet data could not be refreshed.", error);
        balance.textContent = "—";
        balanceState.textContent = "BALANCE LOAD FAILED · RETRY";
        walletRequirement.textContent = error.message || "Funding readiness could not be checked. Try refreshing.";
        setWalletMessage(walletRequirement.textContent, "error");
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
    return { PublicKey, Transaction, TransactionInstruction };
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

function setWithdrawalLinkStatus(message, state = "") {
    const status = document.getElementById("withdrawal-link-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
}

async function verifyDepositSignature(signatureOrLink) {
    if (!supabaseConfigured || !supabase) throw new Error("RelicGrid sign-in is unavailable.");
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
        setWalletMessage("Transaction not confirmed yet. Wait for Solana finalization, then check again; no credits have been added.", "pending");
        return false;
    }
    if (response.status === 404 && result.error === "transaction_not_found") {
        setWalletMessage("Transaction not found on Solana yet. If you just sent it, wait briefly and check again; no credits have been added.", "pending");
        return false;
    }

    if (!response.ok) {
        throw new Error(getDepositVerificationErrorMessage(
            result.error,
            result.message,
            response.status
        ));
    }
    if (result.status !== "confirmed" || !/^\d+$/.test(String(result.amountRaw)) ||
        !Number.isInteger(result.tokenDecimals) ||
        !/^\d+$/.test(String(result.creditAmountCredits)) ||
        !/^\d+$/.test(String(result.balanceCredits))) {
        throw new Error("Backend did not return a confirmed deposit and verified balance.");
    }
    document.getElementById("wallet-balance").textContent = formatCredits(result.balanceCredits);
    document.getElementById("wallet-balance-state").textContent = "CREDITS · BACKEND VERIFIED";
    document.getElementById("deposit-signature").value = "";
    await refreshWallet();
    const confirmedTokenAmount = `${formatTokenAmount(result.amountRaw, result.tokenDecimals)} CYFUR`;
    setWalletMessage(
        result.alreadyProcessed
            ? `${confirmedTokenAmount} was already credited as ${formatCredits(result.creditAmountCredits)} credits. Current verified balance: ${formatCredits(result.balanceCredits)} credits.`
            : `Deposit finalized: ${confirmedTokenAmount} → ${formatCredits(result.creditAmountCredits)} credits. Current verified balance: ${formatCredits(result.balanceCredits)} credits.`,
        "confirmed"
    );
    return true;
}

async function getWalletAuthorizationHeaders() {
    if (!supabaseConfigured || !supabase) throw new Error("RelicGrid sign-in is unavailable.");
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
            const message = "Phantom connected. Approve the receiving-wallet ownership message; this does not transfer tokens.";
            setWalletMessage(message, "pending");
            setWithdrawalLinkStatus(message, "pending");
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
            await refreshWithdrawalStatus();
            const walletConnection = await connectPhantom(window);
            if (walletConnection?.publicKey !== walletStatusSnapshot?.linkedWalletAddress) {
                throw new Error("The Phantom session does not match the wallet linked to this game account.");
            }
            const message = "The receiving wallet ownership proof is verified and linked to this game account.";
            setWalletMessage(message, "ready");
            setWithdrawalLinkStatus(`${message} No transfer was made.`, "ready");
            return;
        }

        if (state.action === "deposit-sign") {
            const config = walletStatusSnapshot;
            if (!config?.depositsEnabled || config.network !== state.network ||
                !config.linkedWalletAddress) {
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
                    transaction: bytesToWalletBase64(transactionBytes)
                });
            } catch (error) {
                if (error.code !== "blockhash_expired") throw error;
                throw new Error("The Phantom transfer expired before it could be submitted. Start a new transfer from your wallet.");
            }
            broadcastSignature = broadcast.signature;
            document.getElementById("deposit-signature").value = broadcastSignature;
            setWalletMessage("Phantom approved the transaction. Waiting for the server to verify its finalized transfer before crediting.", "pending");
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

async function finishOpeningFlow() {
    if (openingFlowFinished || activeOpeningVideoSource !== "gamevideo.mp4") return;
    if (!await stopVideoPlayback(introVideo)) {
        videoCaption.textContent = "Video orientation could not be restored. Retry to continue.";
        videoAction.textContent = "RETRY VIDEO ORIENTATION";
        videoAction.hidden = false;
        videoAction.onclick = () => void finishOpeningFlow();
        return;
    }
    openingFlowFinished = true;
    activeOpeningVideoSource = null;
    player.watchedGameIntro = true;
    savePlayer();
    introVideo.hidden = true;
    transitionVideo.hidden = true;
    videoAction.hidden = true;
    videoAction.onclick = null;
    videoSkip.hidden = true;
    videoSkip.onclick = null;
    delete videoScreen.dataset.openingSequence;
    delete videoScreen.dataset.companyIntro;
    delete videoScreen.dataset.openingVideoSize;
    await enterGameMenu();
}

async function enterGameMenu() {
    if (accountEmailConfirmationCallback) {
        await backendReady;
        if (authUser?.email_confirmed_at) {
            showScreen("profile-screen");
            return;
        }
    }
    showNameOrHome();
    if (player.name) {
        document.getElementById("wallet-card").scrollIntoView({ behavior: "auto", block: "start" });
    }
    if (player.name && new URL(window.location.href).searchParams.has("phantom_handoff")) {
        void backendReady.then(() => refreshWallet());
    }
    if (pendingPhantomMobileCallback) {
        const callback = pendingPhantomMobileCallback;
        pendingPhantomMobileCallback = null;
        await handlePhantomMobileCallback(callback);
    }
}

function playCampaignEnding() {
    let finished = false;
    const finish = async () => {
        if (finished) return;
        if (!await stopVideoPlayback(transitionVideo)) {
            offerContinue("Portrait orientation could not be restored. Retry to continue.");
            return;
        }
        finished = true;
        delete videoScreen.dataset.fullscreenVideo;
        transitionVideo.hidden = true;
        videoSkip.hidden = true;
        videoSkip.onclick = null;
        videoAction.hidden = true;
        showNameOrHome();
    };
    const offerContinue = (message) => {
        void stopVideoPlayback(transitionVideo);
        delete videoScreen.dataset.fullscreenVideo;
        transitionVideo.hidden = true;
        videoCaption.textContent = message;
        videoAction.textContent = "CONTINUE →";
        videoAction.hidden = false;
        videoAction.onclick = () => void finish();
    };

    showScreen("video-screen");
    videoScreen.dataset.fullscreenVideo = "true";
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
    videoSkip.onclick = () => void finish();
    transitionVideo.onended = () => void finish();
    void playVideoInOrientation(transitionVideo, (error) => {
        console.warn("Campaign ending video could not autoplay.", error);
        delete videoScreen.dataset.fullscreenVideo;
        transitionVideo.hidden = true;
        videoCaption.textContent = "Tap to play the final transmission.";
        videoAction.textContent = "PLAY ENDING →";
        videoAction.hidden = false;
        videoAction.onclick = () => {
            videoScreen.dataset.fullscreenVideo = "true";
            transitionVideo.hidden = false;
            videoAction.hidden = true;
            void playVideoInOrientation(transitionVideo, (retryError) => {
                console.error("Campaign ending video could not start after interaction.", retryError);
                delete videoScreen.dataset.fullscreenVideo;
                transitionVideo.hidden = true;
                offerContinue("The campaign ending video could not be played.");
            }, undefined, "landscape");
        };
    }, undefined, "landscape");
}

async function playLevelTransition(nextLevel, milestone) {
    if (transitionInProgress) return;
    transitionInProgress = true;
    await stopVideoPlayback(introVideo);
    const transitionClips = ["levels1.mp4", "levels2.mp4"];
    const clip = milestone === LEVEL_TRANSITION_MILESTONES[0]
        ? transitionClips[0]
        : milestone === LEVEL_TRANSITION_MILESTONES[1]
            ? transitionClips[1]
            : transitionClips[Math.floor(Math.random() * transitionClips.length)];
    let finished = false;
    const finish = async () => {
        if (finished) return;
        if (!await stopVideoPlayback(transitionVideo)) {
            offerContinue(new Error("Native portrait orientation could not be restored."));
            return;
        }
        finished = true;
        transitionInProgress = false;
        delete videoScreen.dataset.fullscreenVideo;
        player.transitionMilestonesPlayed = [...new Set([
            ...player.transitionMilestonesPlayed,
            milestone
        ])];
        savePlayer();
        transitionVideo.hidden = true;
        videoSkip.hidden = true;
        videoAction.hidden = true;
        startLevel(nextLevel, true);
    };
    const offerContinue = (error) => {
        void stopVideoPlayback(transitionVideo);
        delete videoScreen.dataset.fullscreenVideo;
        transitionVideo.hidden = true;
        console.error(`Inter-level transmission ${clip} could not be played.`, error);
        videoCaption.textContent = "Transmission unavailable. Continue to the next sector when ready.";
        videoAction.textContent = "CONTINUE →";
        videoAction.hidden = false;
        videoAction.onclick = () => void finish();
    };

    showScreen("video-screen");
    videoScreen.dataset.fullscreenVideo = "true";
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
    videoSkip.onclick = () => void finish();
    transitionVideo.onended = () => void finish();
    await playVideoInOrientation(transitionVideo, offerContinue, undefined, "landscape");
}

function clearCompletedOpeningVideo() {
    introVideo.pause();
    introVideo.onerror = null;
    introVideo.onended = null;
    activeVideoPlayback = null;
    rotateDevicePrompt.hidden = true;
    delete videoScreen.dataset.orientationBlocked;
}

function playGameVideo() {
    if (openingFlowFinished) return;
    showScreen("video-screen");
    videoScreen.dataset.openingSequence = "true";
    videoScreen.dataset.companyIntro = "false";
    videoAction.hidden = true;
    videoAction.onclick = null;
    videoSkip.textContent = "SKIP GAME VIDEO  →";
    videoSkip.hidden = false;
    videoSkip.onclick = () => void finishOpeningFlow();
    playOpeningVideo("gamevideo.mp4", "Your next signal is coming online…", () => {
        void finishOpeningFlow();
    }, true);
}

function playOpeningVideo(source, caption, onEnded, allowSkip = false) {
    const playbackSequence = ++openingVideoSequence;
    activeOpeningVideoSource = source;
    const orientation = source === "gamevideo.mp4" ? "landscape" : "portrait";
    introVideo.pause();
    introVideo.onerror = null;
    introVideo.onended = null;
    introVideo.src = source;
    introVideo.muted = true;
    introVideo.load();
    introVideo.hidden = false;
    transitionVideo.hidden = true;
    videoSkip.textContent = "SKIP VIDEO  →";
    videoSkip.hidden = !allowSkip;
    videoSkip.onclick = allowSkip ? () => void finishOpeningFlow() : null;
    const showPlayNow = source === "intro.mp4";
    videoAction.textContent = "PLAY NOW →";
    videoAction.hidden = !showPlayNow;
    videoAction.onclick = showPlayNow ? playGameVideo : null;
    videoCaption.textContent = caption;
    videoScreen.dataset.openingSequence = "true";
    videoScreen.dataset.companyIntro = String(source === "companyintro.mp4");
    videoScreen.dataset.openingVideoSize = source === "gamevideo.mp4" ? "fullscreen" : "fit";
    if (introVideo.readyState < HTMLMediaElement.HAVE_METADATA) {
        introVideo.addEventListener("loadedmetadata", () => fitVideoFrame(introVideo), { once: true });
    } else {
        fitVideoFrame(introVideo);
    }
    introVideo.onended = () => {
        if (playbackSequence !== openingVideoSequence || !introVideo.ended) return;
        clearCompletedOpeningVideo();
        if (source === "companyintro.mp4") {
            playOpeningVideo("intro.mp4", "RelicGrid introduction", () => {});
            return;
        }
        if (source === "intro.mp4") {
            playGameVideo();
            return;
        }
        onEnded();
    };
    const offerNext = (error) => {
        console.error(`${caption} could not be played.`, error);
        videoScreen.dataset.companyIntro = "false";
        videoCaption.textContent = `${caption} could not be played.`;
        videoAction.textContent = "RETRY VIDEO  →";
        videoAction.hidden = false;
        videoAction.onclick = () => {
            playOpeningVideo(source, caption, onEnded, allowSkip);
        };
    };
    void playVideoInOrientation(
        introVideo,
        offerNext,
        () => {
            introVideo.muted = false;
            if (allowSkip && source === "gamevideo.mp4") {
                videoSkip.textContent = "SKIP GAME VIDEO  →";
                videoSkip.hidden = false;
                videoSkip.onclick = () => void finishOpeningFlow();
            }
        },
        orientation
    );
}

async function showOpeningIntro() {
    if (openingFlowFinished) return;
    await stopVideoPlayback(transitionVideo);
    showScreen("video-screen");
    videoScreen.dataset.openingSequence = "true";
    videoScreen.dataset.companyIntro = "true";
    videoAction.hidden = true;
    videoAction.onclick = null;
    videoSkip.hidden = true;
    videoSkip.onclick = null;
    videoCaption.textContent = "";
    playOpeningVideo("companyintro.mp4", "", () => {});
}

function fitVideoFrame(video) {
    if (videoScreen.dataset.fullscreenVideo === "true" ||
        (video === introVideo &&
            videoScreen.dataset.openingSequence === "true" &&
            videoScreen.dataset.openingVideoSize === "fullscreen")) {
        videoScreen.style.setProperty("--phone-width", "100vw");
        videoScreen.style.setProperty("--phone-height", "100dvh");
        return;
    }
    if (!video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(
        (window.innerWidth - 24) / video.videoWidth,
        (window.innerHeight - 24) / video.videoHeight
    );
    videoScreen.style.setProperty("--phone-width", `${video.videoWidth * scale}px`);
    videoScreen.style.setProperty("--phone-height", `${video.videoHeight * scale}px`);
}

async function startLevel(number, resumeMusic = false) {
    if (levelStartInProgress) return false;
    const level = levels[number - 1];
    if (!level) return false;
    if (levelsGloballyLocked) {
        setLevelEntryMessage("All levels are temporarily locked. Your saved progress is unchanged.", "disabled");
        return false;
    }
    levelStartInProgress = true;
    const musicWasPlaying = musicStarted && !backgroundMusic.paused;
    if (resumeMusic || !musicStarted || backgroundMusic.paused) startMusic();
    const stopNewMusic = () => {
        if (!musicWasPlaying) stopMusic();
    };
    try {
        const entry = await requestLevelEntry(number);
        if (!entry) {
            stopNewMusic();
            return false;
        }
        const gameGuide = document.getElementById("game-guide");
        const showTutorial = number === 1 && !player.tutorialSeen;
        gameGuide.hidden = !showTutorial;
        document.getElementById("first-level-tutorial").hidden = !showTutorial;
        document.getElementById("game-guide-toggle").setAttribute("aria-expanded", String(showTutorial));
        activeWalletLevelSessionId = entry.sessionId;
        activeLevelEntryCostCredits = entry.practice ? null : Number(entry.entryCostCredits);
        walletTimerStartPromise = Promise.resolve(false);
        if (!entry.practice) {
            document.getElementById("wallet-balance").textContent = formatCredits(entry.balanceCredits);
            document.getElementById("wallet-balance-state").textContent = "CREDITS · BACKEND VERIFIED";
            document.getElementById("completion-balance").textContent =
                `${formatCredits(entry.balanceCredits)} credits`;
            document.getElementById("completion-balance-note").textContent =
                "Available after entry fee";
            walletStatusSnapshot = {
                ...walletStatusSnapshot,
                balanceCredits: String(entry.balanceCredits),
                balanceVerified: true
            };
        }
        const entryMessage = entry.practice
            ? `Level ${String(number).padStart(2, "0")} started in free practice. No credits were charged; progress and rewards will not be saved.`
            : `Level ${String(number).padStart(2, "0")} started. ${formatCredits(entry.entryCostCredits)} wallet credits deducted; verified balance ${formatCredits(entry.balanceCredits)}.`;
        setLevelEntryMessage(entryMessage, entry.practice ? "ready" : "success");
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
                    entryCostCredits: activeLevelEntryCostCredits,
                    gamePointsSession: false,
                    tutorial: showTutorial
                }
            }));
        }, 0);
        return true;
    } catch (error) {
        stopNewMusic();
        throw error;
    } finally {
        levelStartInProgress = false;
    }
}

function leaveGameplay(toHome = true) {
    stopMusic();
    if (toHome) renderHome();
}

window.addEventListener("fluxgrid:core-activation-start", pauseMusic);
window.addEventListener("fluxgrid:core-activation-cancel", startMusic);

document.getElementById("account-upgrade-form").addEventListener("submit", requestAccountUpgrade);
document.getElementById("account-upgrade-code-form").addEventListener("submit", verifyAccountUpgrade);
document.getElementById("account-recovery-form").addEventListener("submit", requestAccountRecovery);
document.getElementById("account-recovery-code-form").addEventListener("submit", verifyAccountRecovery);

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
                console.error("Player callsign could not be saved to RelicGrid.", error);
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
document.getElementById("next-level").addEventListener("click", async (event) => {
    const number = Number(event.currentTarget.dataset.nextLevel);
    if (!Number.isInteger(number) || number < 1 || number > 99) return;
    const milestone = getPendingLevelTransition(
        number - 1,
        player.transitionMilestonesPlayed
    );
    if (milestone !== null) {
        playLevelTransition(number, milestone);
    } else {
        try {
            const started = await startLevel(number, true);
            if (!started) {
                document.getElementById("game-status").textContent =
                    document.getElementById("level-entry-status").textContent;
            }
        } catch (error) {
            console.error(`Level ${number} could not be started from the completion screen.`, error);
            document.getElementById("game-status").textContent = error.message;
        }
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
                    ? "Treasury copied. Send CYFUR to this address, then verify using the transaction ID."
                : "Treasury address copied for setup only. Deposit verification is not READY; do not send CYFUR.",
            depositsReady ? "ready" : "disabled"
        );
    } catch (error) {
        console.error("Deposit address could not be copied.", error);
        document.getElementById("wallet-address-copy-status").textContent = "Copy failed. Select the address to copy it.";
        setWalletMessage(`Address copy failed. Select and copy it manually. ${error.message}`, "error");
    }
});
document.getElementById("home-open-deposit").addEventListener("click", () => {
    document.getElementById("wallet-card").scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("deposit-signature").focus({ preventScroll: true });
});
document.getElementById("deposit-signature-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (depositVerificationInProgress) return;
    const input = document.getElementById("deposit-signature");
    const button = document.getElementById("deposit-verify-button");
    const signatureOrLink = normalizeDepositSignatureInput(input.value);
    if (!signatureOrLink) return;
    depositVerificationInProgress = true;
    button.disabled = true;
    button.textContent = "VERIFYING…";
    setWalletMessage("Verifying your CYFUR transaction on Solana…", "verifying");
    try {
        await verifyDepositSignature(signatureOrLink);
    } catch (error) {
        console.error("Deposit signature verification failed.", error);
        setWalletMessage(error.message, "error");
    } finally {
        depositVerificationInProgress = false;
        button.disabled = walletStatusSnapshot?.depositsEnabled !== true;
        button.textContent = "VERIFY PAYMENT →";
    }
});
document.getElementById("profile-open").addEventListener("click", () => {
    renderProfile();
    showScreen("profile-screen");
});
document.getElementById("wallet-protect-account").addEventListener("click", () => {
    renderProfile();
    showScreen("profile-screen");
    document.getElementById("account-security-heading").scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
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
            launchDirection: detail.launchDirection,
            gamePoints: detail.gamePointsSession === true
        }),
        cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    const gamePointsSession = detail.gamePointsSession === true;
    const rewardAmount = gamePointsSession ? result.rewardPoints : result.rewardCredits;
    const balanceAmount = gamePointsSession ? result.balancePoints : result.balanceCredits;
    if (!response.ok || result.status !== "confirmed" ||
        !/^\d+$/.test(String(rewardAmount)) ||
        !/^\d+$/.test(String(balanceAmount))) {
        throw new Error(result.error || `Secure completion failed (${response.status}).`);
    }

    document.getElementById("completion-stars").textContent = `${result.stars} / 3`;
    document.getElementById("completion-star-icons").textContent =
        `${"★".repeat(result.stars)}${"☆".repeat(3 - result.stars)}`;
    if (Number.isFinite(result.elapsedMilliseconds) && result.elapsedMilliseconds >= 0) {
        document.getElementById("completion-time").textContent =
            `${(result.elapsedMilliseconds / 1000).toFixed(1)} s`;
    }
    if (gamePointsSession) {
        serverGamePoints = String(balanceAmount);
        if (!/^\d+$/.test(serverGamePoints)) {
            throw new Error("The completion response contained an invalid game-points balance.");
        }
        serverGamePointsVerified = true;
        renderLevels();
        player.completedLevels = [...new Set([...player.completedLevels, detail.number])].sort((a, b) => a - b);
        player.unlockedLevel = Math.min(99, Math.max(player.unlockedLevel, detail.number + 1));
        player.lastLevel = Math.min(99, detail.number + 1);
        savePlayer();
    } else {
        document.getElementById("wallet-balance").textContent = formatCredits(balanceAmount);
        document.getElementById("wallet-balance-state").textContent = "CREDITS · BACKEND VERIFIED";
        walletStatusSnapshot = {
            ...walletStatusSnapshot,
            balanceCredits: String(balanceAmount),
            balanceVerified: true
        };
        document.getElementById("completion-balance-note").textContent =
            `${formatCredits(balanceAmount)} off-chain wallet credits · backend verified`;
        renderLevels();
    }
    const displayedRewardAmount = result.duplicate ? "0" : rewardAmount;
    const rewardLabel = document.getElementById("completion-reward-label");
    const reward = document.getElementById("completion-reward");
    const rewardNote = document.getElementById("completion-reward-note");
    rewardLabel.textContent = displayedRewardAmount === "0"
        ? gamePointsSession ? "NO POINT REWARD" : "NO CREDIT REWARD"
        : gamePointsSession ? "CONFIRMED POINT REWARD" : "CONFIRMED CREDIT REWARD";
    reward.textContent = `${formatCredits(displayedRewardAmount)} ${gamePointsSession ? "points" : "credits"}`;
    rewardNote.textContent = result.duplicate
        ? "Level already cleared · repeat reward prevented"
        : displayedRewardAmount === "0"
            ? "No reward for this star rating"
            : "Credited to available balance";
    document.getElementById("completion-balance").textContent = gamePointsSession
        ? `${formatCredits(balanceAmount)} points`
        : `${formatCredits(balanceAmount)} credits`;
    document.getElementById("completion-balance-note").textContent =
        gamePointsSession
            ? "Available game points"
            : "Available wallet credits";

    await refreshOwnProgress();
    backendStatus = "Connected to the RelicGrid leaderboard.";
    return result;
}

async function saveWalletLevelCompletionAutomatically(detail) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await saveWalletLevelCompletion(detail);
        } catch (error) {
            const retryable = /level_completion_unavailable|Secure completion failed \(5\d\d\)|Failed to fetch|NetworkError/i
                .test(error.message);
            if (!retryable || attempt === 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
        }
    }
    throw new Error("Automatic level completion save did not finish.");
}

const withdrawalAddressInput = document.getElementById("withdrawal-wallet-address");
const withdrawalAmountInput = document.getElementById("withdrawal-amount");
const withdrawalMaxButton = document.getElementById("withdrawal-max");
const withdrawalForm = document.getElementById("withdrawal-form");
if (withdrawalForm && withdrawalAddressInput && withdrawalAmountInput && withdrawalMaxButton) {
    withdrawalMaxButton.addEventListener("click", () => {
        const availableCredits = withdrawalMaxButton.dataset.availableCredits || "0";
        if (!/^\d+$/.test(availableCredits) || BigInt(availableCredits) <= 0n) return;
        withdrawalAmountInput.value = formatWithdrawalCreditsAsCyfur(availableCredits);
        updateWithdrawalPreview();
        updateWithdrawalControls();
    });
    withdrawalAddressInput.addEventListener("input", updateWithdrawalControls);
    withdrawalAmountInput.addEventListener("input", () => {
        const value = (withdrawalAmountInput.value || "").trim();
        if (value && parseWithdrawalCredits(value) === null) {
            updateWithdrawalControls();
            setWithdrawalStatus("Enter a CYFUR amount using up to 3 decimal places.", "error");
            return;
        }
        updateWithdrawalPreview();
        updateWithdrawalControls();
    });
    withdrawalForm.addEventListener("submit", submitWithdrawalRequest);
}
document.getElementById("withdrawal-refresh")?.addEventListener("click", () => {
    void refreshWithdrawalStatus();
});

window.addEventListener("fluxgrid:level-timer-start", (event) => {
    const sessionId = event.detail?.walletSessionId;
    const gamePoints = event.detail?.gamePointsSession === true;
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
            body: JSON.stringify({ sessionId, gamePoints }),
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
            const result = await saveWalletLevelCompletionAutomatically(detail);
            const rewardAmount = detail.gamePointsSession ? result.rewardPoints : result.rewardCredits;
            const rewardUnit = detail.gamePointsSession ? "game points" : "credits";
            setLevelEntryMessage(
                `Level ${number} saved. ${rewardAmount} ${rewardUnit} ${rewardAmount === "0" ? "awarded" : "confirmed"}; balance is backend verified.`,
                "success"
            );
        } catch (error) {
            console.error("Server-verified level completion could not be saved.", error);
            document.getElementById("completion-reward-note").textContent =
                `Credit not confirmed: ${error.message}`;
            document.getElementById("completion-balance-note").textContent =
                "Showing the last server-confirmed balance";
            document.getElementById("game-status").textContent =
                `Level ${number} is not recorded and no reward was credited: ${error.message}`;
            const nextLevelButton = document.getElementById("next-level");
            nextLevelButton.hidden = false;
            nextLevelButton.disabled = number >= 99;
            nextLevelButton.dataset.nextLevel = String(number + 1);
            nextLevelButton.textContent = number >= 99 ? "CAMPAIGN COMPLETE" : "NEXT LEVEL →";
            return;
        }
    } else {
        const nextLevelButton = document.getElementById("next-level");
        nextLevelButton.hidden = false;
        nextLevelButton.disabled = number >= 99;
        nextLevelButton.dataset.nextLevel = String(number + 1);
        nextLevelButton.textContent = number >= 99 ? "PRACTICE COMPLETE" : "NEXT LEVEL →";
        document.getElementById("game-status").textContent =
            "Practice complete. No credits, leaderboard points, or saved progress were awarded.";
        return;
    }

    const nextLevelButton = document.getElementById("next-level");
    nextLevelButton.hidden = false;
    nextLevelButton.disabled = number >= 99;
    nextLevelButton.dataset.nextLevel = String(number + 1);
    nextLevelButton.textContent = number >= 99 ? "CAMPAIGN COMPLETE" : "NEXT LEVEL →";
    renderProfile();
});

backendReady = initializeBackend();
if (Capacitor.isNativePlatform()) {
    setNativePhantomCallback({
        scheme: "relicgrid",
        appUrl: new URL(GAME_API_BASE_URL).origin
    });
    void StatusBar.hide().catch((error) => {
        console.warn("Native status bar could not be hidden.", error);
    });
    const handledNativeCallbacks = new Set();
    const handleNativeAppUrl = (url) => {
        if (!url) return;
        if (handledNativeCallbacks.has(url)) return;
        const callback = readPhantomMobileCallback(window, url);
        if (!callback) return;
        handledNativeCallbacks.add(url);
        if (!openingFlowFinished) {
            pendingPhantomMobileCallback = callback;
            return;
        }
        showNameOrHome();
        void handlePhantomMobileCallback(callback);
    };
    void App.addListener("appUrlOpen", ({ url }) => handleNativeAppUrl(url)).catch((error) => {
        console.error("Native wallet return handler could not be registered.", error);
    });
    void App.getLaunchUrl().then((launch) => {
        if (launch?.url) handleNativeAppUrl(launch.url);
    }).catch((error) => {
        console.error("Native app launch URL could not be checked.", error);
    });
    document.addEventListener("click", (event) => {
        const anchor = event.target instanceof Element
            ? event.target.closest('a[target="_blank"]')
            : null;
        if (!anchor) return;
        const url = new URL(anchor.href);
        if (url.protocol !== "https:") return;
        event.preventDefault();
        void Browser.open({ url: url.toString() }).catch((error) => {
            console.error("External page could not be opened from the native app.", error);
        });
    }, true);
}
const phantomMobileCallback = readPhantomMobileCallback(window);
pendingPhantomMobileCallback = phantomMobileCallback;
void showOpeningIntro();
