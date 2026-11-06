function areLevelsGloballyLocked(environment = process.env) {
    return environment.LEVELS_LOCKED?.trim().toLowerCase() === "true";
}

module.exports = { areLevelsGloballyLocked };
