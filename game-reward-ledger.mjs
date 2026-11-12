export function normalizeLocalGameRewardEntries(entries) {
    if (!Array.isArray(entries)) return [];
    const validEntries = entries.filter((entry) =>
        entry &&
        typeof entry.entryId === "string" &&
        entry.entryId.length > 0 &&
        Number.isInteger(entry.levelNumber) &&
        entry.levelNumber >= 1 &&
        entry.levelNumber <= 99 &&
        Number.isInteger(entry.stars) &&
        entry.stars >= 1 &&
        entry.stars <= 3 &&
        typeof entry.amountCredits === "string" &&
        /^\d+$/.test(entry.amountCredits) &&
        typeof entry.awardedAt === "string" &&
        Number.isFinite(Date.parse(entry.awardedAt))
    );
    const uniqueEntries = new Map();
    for (const entry of validEntries) {
        if (!uniqueEntries.has(entry.entryId)) uniqueEntries.set(entry.entryId, entry);
    }
    return [...uniqueEntries.values()];
}

export function getLocalGameRewardBalance(entries) {
    return normalizeLocalGameRewardEntries(entries)
        .reduce((balance, entry) => balance + BigInt(entry.amountCredits), 0n)
        .toString();
}

export function awardLocalGameReward(entries, {
    entryId,
    levelNumber,
    stars,
    amountCredits,
    awardedAt = new Date().toISOString()
}) {
    const currentEntries = normalizeLocalGameRewardEntries(entries);
    if (typeof entryId !== "string" || entryId.length === 0 ||
        !Number.isInteger(levelNumber) || levelNumber < 1 || levelNumber > 99 ||
        !Number.isInteger(stars) || stars < 1 || stars > 3 ||
        !Number.isSafeInteger(amountCredits) || amountCredits < 0 ||
        typeof awardedAt !== "string" || !Number.isFinite(Date.parse(awardedAt))) {
        throw new TypeError("A valid paid level reward record is required.");
    }

    if (currentEntries.some((entry) => entry.entryId === entryId)) {
        return {
            entries: currentEntries,
            balanceCredits: getLocalGameRewardBalance(currentEntries),
            awarded: false
        };
    }

    const nextEntries = [
        ...currentEntries,
        { entryId, levelNumber, stars, amountCredits: String(amountCredits), awardedAt }
    ];
    return {
        entries: nextEntries,
        balanceCredits: getLocalGameRewardBalance(nextEntries),
        awarded: true
    };
}
