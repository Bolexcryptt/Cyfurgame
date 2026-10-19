import { levels } from "./levels.js";
import { supabase, supabaseConfigured } from "./supabase.js";

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
const videoCaption = document.getElementById("video-caption");
const backgroundMusic = document.getElementById("background-music");
const playerNameInput = document.getElementById("player-name");

function readPlayer() {
    const saved = localStorage.getItem(storageKey);
    if (!saved) {
        return {
            name: "",
            playerId: "",
            watchedGameIntro: false,
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
            unlockedLevel: Math.min(99, Math.max(1, Number(parsed.unlockedLevel) || 1)),
            completedLevels: Array.isArray(parsed.completedLevels)
                ? [...new Set(parsed.completedLevels.filter((level) => Number.isInteger(level) && level >= 1 && level <= 99))]
                : [],
            lastLevel: Math.min(99, Math.max(1, Number(parsed.lastLevel) || 1))
        };
    } catch (error) {
        console.warn("Saved FluxGrid profile could not be read; starting a fresh local profile.", error);
        return {
            name: "",
            playerId: "",
            watchedGameIntro: false,
            unlockedLevel: 1,
            completedLevels: [],
            lastLevel: 1
        };
    }
}

let player = readPlayer();
let pendingLevel = null;
let transitionNextLevel = null;
let introFinished = false;
let musicStarted = false;
let authUser = null;
let backendStatus = supabaseConfigured ? "Connecting to Supabase…" : "Supabase is not configured.";
let backendReady;

function savePlayer() {
    localStorage.setItem(storageKey, JSON.stringify(player));
}

function nextUnlockedLevel(completedLevels) {
    const completed = new Set(completedLevels);
    let next = 1;
    while (completed.has(next) && next < 99) next++;
    return next;
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
        backendStatus = "Connected to the FluxGrid leaderboard.";
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
        `${String(player.unlockedLevel).padStart(2, "0")} / 99`;
    const progressFill = document.getElementById("campaign-progress-fill");
    if (progressFill) {
        progressFill.style.width = `${Math.min(100, (player.unlockedLevel - 1) / 99 * 100)}%`;
    }
    const nextLevel = levels[player.unlockedLevel - 1];
    const nextLevelLabel = document.getElementById("hero-next-level");
    if (nextLevelLabel) {
        nextLevelLabel.textContent = nextLevel ? `SECTOR ${String(nextLevel.number).padStart(2, "0")}` : "CAMPAIGN COMPLETE";
    }

    const profileDetails = document.getElementById("profile-details");
    profileDetails.replaceChildren(
        statCard("CALLSIGN", name),
        statCard("PLAYER ID", player.playerId || "Available after Supabase setup"),
        statCard("LEVELS COMPLETED", `${completed} / 99`),
        statCard("HIGHEST UNLOCKED", `LEVEL ${String(player.unlockedLevel).padStart(2, "0")}`),
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
    for (const level of levels) {
        const completed = player.completedLevels.includes(level.number);
        const unlocked = level.number <= player.unlockedLevel;
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.style.setProperty("--card-index", String((level.number - 1) % 12));
        button.className = `level-card${completed ? " is-complete" : ""}${unlocked ? " is-unlocked" : " is-locked"}`;
        button.type = "button";
        button.disabled = !unlocked;
        button.dataset.level = String(level.number);
        button.setAttribute("aria-label", `Level ${level.number}, ${completed ? "completed" : unlocked ? "unlocked" : "locked"}`);

        const number = document.createElement("span");
        number.className = "level-number";
        number.textContent = String(level.number).padStart(2, "0");
        const detail = document.createElement("span");
        detail.className = "level-detail";
        const title = document.createElement("b");
        title.textContent = level.title;
        const meta = document.createElement("small");
        meta.textContent = `${level.par} MIRROR${level.par === 1 ? "" : "S"} REQUIRED · TIER ${level.band}`;
        detail.append(title, meta);
        const badge = document.createElement("span");
        badge.className = "level-state";
        badge.textContent = completed ? "CLEARED" : unlocked ? (level.number === player.lastLevel ? "CONTINUE" : "OPEN") : "LOCKED";
        button.append(number, detail, badge);
        button.addEventListener("click", () => startLevel(level.number));
        item.append(button);
        fragment.append(item);
    }
    list.replaceChildren(fragment);
}

function renderHome() {
    renderProfile();
    renderLevels();
    showScreen("home-screen");
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
    transitionVideo.muted = true;
    transitionVideo.onended = () => {
        player.watchedGameIntro = true;
        savePlayer();
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
        transitionVideo.onerror = () => {
            console.error("Gameplay introduction video could not be decoded.", transitionVideo.error);
            videoCaption.textContent = "This browser could not play the introduction video.";
            videoAction.textContent = "CONTINUE WITHOUT VIDEO  →";
            videoAction.hidden = false;
            videoAction.onclick = () => {
                transitionVideo.hidden = true;
                showNameOrHome();
            };
        };
    };
    videoAction.hidden = true;
    videoCaption.textContent = "Initializing your first mission…";
    const playback = transitionVideo.play();
    if (playback && typeof playback.catch === "function") {
        playback.catch((error) => {
            console.warn("Gameplay introduction video could not start.", error);
            videoCaption.textContent = "This browser could not play the introduction video.";
            videoAction.textContent = "CONTINUE WITHOUT VIDEO  →";
            videoAction.hidden = false;
            videoAction.onclick = () => {
                transitionVideo.hidden = true;
                showNameOrHome();
            };
        });
    }
}

function continueAfterIntro() {
    if (player.watchedGameIntro) {
        showNameOrHome();
        return;
    }
    beginGameIntro();
}

function showOpeningIntro() {
    showScreen("video-screen");
    transitionVideo.hidden = true;
    introVideo.hidden = false;
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
            videoCaption.textContent = "Play the opening transmission.";
            videoAction.textContent = "PLAY INTRO  →";
            videoAction.hidden = false;
            videoAction.onclick = () => introVideo.play();
        });
    }
}

function startLevel(number, resumeMusic = false) {
    const level = levels[number - 1];
    if (!level || number > player.unlockedLevel) return;
    player.lastLevel = number;
    pendingLevel = level;
    savePlayer();
    document.getElementById("play-level").textContent = `LEVEL ${String(number).padStart(2, "0")}`;
    document.getElementById("play-level-title").textContent = level.title;
    showScreen("play-screen");
    window.setTimeout(() => {
        window.fluxGridSceneResize?.();
        window.dispatchEvent(new CustomEvent("fluxgrid:load-level", { detail: level }));
    }, 0);
    if (resumeMusic || !musicStarted) startMusic();
}

function leaveGameplay(toHome = true) {
    stopMusic();
    if (toHome) renderHome();
}

function transitionFor(completedLevel) {
    if (completedLevel === 1) return "levels1.mp4";
    if (completedLevel === 8) return "levels2.mp4";
    return Math.random() < 0.12 ? (Math.random() < 0.5 ? "levels1.mp4" : "levels2.mp4") : null;
}

function playLevelTransition(videoFile, nextLevel) {
    transitionNextLevel = nextLevel;
    introVideo.pause();
    transitionVideo.src = videoFile;
    transitionVideo.currentTime = 0;
    transitionVideo.hidden = false;
    showScreen("video-screen");
    videoCaption.textContent = `Signal transfer · Level ${String(nextLevel).padStart(2, "0")}`;
    videoAction.hidden = true;
    transitionVideo.onended = () => {
        transitionVideo.hidden = true;
        videoAction.textContent = `CONTINUE TO LEVEL ${String(transitionNextLevel).padStart(2, "0")}  →`;
        videoAction.hidden = false;
        videoAction.onclick = () => {
            videoAction.hidden = true;
            startLevel(transitionNextLevel, true);
        };
        transitionVideo.onerror = () => {
            console.error(`Transition video ${videoFile} could not be decoded.`, transitionVideo.error);
            videoCaption.textContent = "The transfer video is unavailable; your level is already unlocked.";
            videoAction.textContent = `CONTINUE TO LEVEL ${String(nextLevel).padStart(2, "0")}  →`;
            videoAction.hidden = false;
            videoAction.onclick = () => startLevel(nextLevel, true);
        };
        videoCaption.textContent = "Transfer complete.";
    };
    const playback = transitionVideo.play();
    if (playback && typeof playback.catch === "function") {
        playback.catch((error) => {
            console.warn(`Transition video ${videoFile} could not start.`, error);
            videoAction.textContent = `CONTINUE TO LEVEL ${String(nextLevel).padStart(2, "0")}  →`;
            videoAction.hidden = false;
            videoAction.onclick = () => startLevel(nextLevel, true);
        });
    }
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
    startLevel(Math.min(player.lastLevel, player.unlockedLevel));
});
document.getElementById("leaderboard-open").addEventListener("click", () => {
    showScreen("leaderboard-screen");
    void refreshLeaderboard();
});
document.getElementById("leaderboard-refresh").addEventListener("click", () => {
    void refreshLeaderboard();
});
document.getElementById("profile-open").addEventListener("click", () => {
    renderProfile();
    showScreen("profile-screen");
});
document.getElementById("levels-open").addEventListener("click", () => leaveGameplay());
document.getElementById("play-home").addEventListener("click", () => leaveGameplay());
document.querySelectorAll("[data-home]").forEach((button) => button.addEventListener("click", renderHome));

async function saveLevelCompletion(number) {
    if (authUser && supabaseConfigured) {
        try {
            const { error } = await supabase.rpc("record_level_completion", {
                p_level_number: number
            });
            if (error) throw error;
            await refreshOwnProgress();
            backendStatus = "Connected to the FluxGrid leaderboard.";
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

window.addEventListener("fluxgrid:level-complete", (event) => {
    const number = event.detail?.number;
    if (!Number.isInteger(number) || number < 1 || number > 99) {
        console.error("Invalid completed-level event received.", event.detail);
        return;
    }
    void saveLevelCompletion(number);

    const nextLevel = number + 1;
    if (nextLevel <= 99) {
        const transition = transitionFor(number);
        if (transition) {
            backgroundMusic.pause();
            playLevelTransition(transition, nextLevel);
            return;
        }
    }
    renderProfile();
});

backendReady = initializeBackend();
showOpeningIntro();
