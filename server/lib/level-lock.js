function areLevelsGloballyLocked(environment = process.env) {
    return environment.LEVELS_LOCKED !== "false";
}

module.exports = { areLevelsGloballyLocked };
