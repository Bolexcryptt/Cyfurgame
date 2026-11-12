function normalizeEmail(email) {
    if (typeof email !== "string") {
        throw new TypeError("Enter the email address linked to the player account.");
    }
    const normalized = email.trim().toLowerCase();
    if (!normalized || /\s/.test(normalized) || !normalized.includes("@")) {
        throw new TypeError("Enter a valid email address.");
    }
    return normalized;
}

function requireOtp(token) {
    if (typeof token !== "string" || !/^\d{6}$/.test(token.trim())) {
        throw new TypeError("Enter the six-digit verification code.");
    }
    return token.trim();
}

export async function restoreOrCreatePlayerSession(auth) {
    const { data: sessionData, error: sessionError } = await auth.getSession();
    if (sessionError) throw sessionError;

    if (sessionData.session) {
        const { data: userData, error: userError } = await auth.getUser();
        if (userError) throw userError;
        if (!userData.user?.id ||
            (sessionData.session.user?.id && sessionData.session.user.id !== userData.user.id)) {
            throw new Error("The saved RelicGrid player session could not be verified.");
        }
        return { user: userData.user, createdAnonymously: false };
    }

    const { data, error } = await auth.signInAnonymously();
    if (error) throw error;
    if (!data.user?.id) {
        throw new Error("RelicGrid did not return an authenticated player.");
    }
    return { user: data.user, createdAnonymously: true };
}

export function hydratePlayerFromAuthenticatedAccount(player, authUser, profile, serverCompletedLevels) {
    if (!player || typeof authUser?.id !== "string" || !authUser.id ||
        !profile || !Array.isArray(serverCompletedLevels)) {
        throw new TypeError("The authenticated player, profile, and server progress are required.");
    }

    const sameIdentity = player.playerId === authUser.id;
    const completedLevels = [...new Set(serverCompletedLevels.filter((level) =>
        Number.isInteger(level) && level >= 1 && level <= 99
    ))].sort((a, b) => a - b);
    const completed = new Set(completedLevels);
    let nextLevel = 1;
    while (completed.has(nextLevel) && nextLevel < 99) nextLevel += 1;
    const skippedLevels = sameIdentity && Array.isArray(player.skippedLevels)
        ? [...new Set(player.skippedLevels.filter((level) =>
            Number.isInteger(level) && level >= 1 && level < 99 && !completed.has(level)
        ))]
        : [];
    const nextAfterSkip = skippedLevels.reduce(
        (next, level) => Math.max(next, level + 1),
        1
    );

    return {
        ...player,
        name: profile.display_name || (sameIdentity ? player.name : ""),
        playerId: authUser.id,
        completedLevels,
        skippedLevels,
        unlockedLevel: Math.max(nextLevel, nextAfterSkip),
        lastLevel: sameIdentity
            ? Math.min(99, Math.max(1, Number(player.lastLevel) || nextLevel))
            : nextLevel,
        transitionMilestonesPlayed: sameIdentity
            ? player.transitionMilestonesPlayed
            : []
    };
}

export async function requestAccountEmailLink(auth, email, emailRedirectTo) {
    if (typeof emailRedirectTo !== "string") {
        throw new TypeError("The RelicGrid email confirmation address is unavailable.");
    }
    let redirectUrl;
    try {
        redirectUrl = new URL(emailRedirectTo);
    } catch {
        throw new TypeError("The RelicGrid email confirmation address is invalid.");
    }
    if (redirectUrl.protocol !== "https:" || redirectUrl.username || redirectUrl.password) {
        throw new TypeError("The RelicGrid email confirmation address must use HTTPS.");
    }
    const result = await auth.updateUser(
        { email: normalizeEmail(email) },
        { emailRedirectTo: redirectUrl.toString() }
    );
    if (result.error) throw result.error;
    return result.data.user;
}

export async function verifyAccountEmailLink(auth, email, token) {
    const result = await auth.verifyOtp({
        email: normalizeEmail(email),
        token: requireOtp(token),
        type: "email_change"
    });
    if (result.error) throw result.error;
    if (!result.data.user?.id) throw new Error("RelicGrid did not verify the linked email.");
    return result.data.user;
}

export function isAccountEmailConfirmationCallback(location) {
    if (!location || typeof location.search !== "string" ||
        typeof location.hash !== "string") return false;
    const query = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    return query.get("auth") === "email-confirmed" || hash.get("type") === "email_change";
}

export async function requestExistingAccountRecovery(auth, email) {
    const result = await auth.signInWithOtp({
        email: normalizeEmail(email),
        options: { shouldCreateUser: false }
    });
    if (result.error) throw result.error;
}

export async function verifyExistingAccountRecovery(auth, email, token) {
    const result = await auth.verifyOtp({
        email: normalizeEmail(email),
        token: requireOtp(token),
        type: "email"
    });
    if (result.error) throw result.error;
    if (!result.data.user?.id || result.data.user.is_anonymous === true) {
        throw new Error("The recovery code did not authenticate a permanent player account.");
    }
    return result.data.user;
}
