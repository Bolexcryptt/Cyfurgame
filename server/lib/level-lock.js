function areLevelsGloballyLocked(environment = process.env) {
    return environment.LEVELS_LOCKED !== undefined && environment.LEVELS_LOCKED !== "false";
}

module.exports = { areLevelsGloballyLocked };
