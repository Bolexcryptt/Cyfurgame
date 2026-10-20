const requiredEnvironment = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"];
const CYFUR_CREDITS_PER_TOKEN = 10000;
const MAX_DATABASE_BIGINT = 9223372036854775807n;

function getLevelEntryCostCredits(levelNumber) {
    if (!Number.isInteger(levelNumber) || levelNumber < 1 || levelNumber > 99) return null;
    return Math.floor(100 * Math.pow(1.08, levelNumber - 1));
}

function getDepositCreditAmount(amountRaw, tokenDecimals, roundingPolicy) {
    if (typeof amountRaw !== "string" || !/^[1-9]\d*$/.test(amountRaw)) {
        throw new TypeError("Deposit amount must be a positive integer string.");
    }
    if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
        throw new TypeError("Token decimals must be an integer from 0 to 18.");
    }
    if (!["floor", "nearest", "reject_fraction"].includes(roundingPolicy)) {
        throw new TypeError("A supported deposit rounding policy must be configured.");
    }

    const numerator = BigInt(amountRaw) * BigInt(CYFUR_CREDITS_PER_TOKEN);
    const denominator = 10n ** BigInt(tokenDecimals);
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    if (roundingPolicy === "reject_fraction" && remainder !== 0n) {
        throw new RangeError("Deposit amount does not convert to a whole number of credits.");
    }
    const credits = roundingPolicy === "nearest" && remainder * 2n >= denominator
        ? quotient + 1n
        : quotient;
    if (credits <= 0n || credits > MAX_DATABASE_BIGINT) {
        throw new RangeError("Deposit credit amount is outside the supported range.");
    }
    return credits.toString();
}

function hasWalletEnvironment() {
    return requiredEnvironment.every((name) => Boolean(process.env[name]?.trim()));
}

function hasServiceDatabaseEnvironment() {
    return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

function sendJson(response, status, payload) {
    response.status(status);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.json(payload);
}

async function authenticate(request) {
    const authorization = request.headers.authorization;
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return null;

    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/user`, {
        headers: {
            apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${token}`
        }
    });
    if (!response.ok) return null;

    const user = await response.json();
    return typeof user.id === "string" ? user : null;
}

async function selectOwn(request, table, query) {
    const authorization = request.headers.authorization;
    const url = new URL(`/rest/v1/${table}`, process.env.SUPABASE_URL);
    url.search = query.toString();
    const response = await fetch(url, {
        headers: {
            apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
            Authorization: authorization,
            Accept: "application/json"
        }
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = new Error("Wallet data could not be loaded.");
        error.status = response.status;
        error.code = detail.code;
        throw error;
    }
    const body = await response.text();
    return body ? JSON.parse(body) : [];
}

async function serviceRequest(path, options = {}) {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${path}`, {
        ...options,
        headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            Accept: "application/json",
            ...options.headers
        },
        cache: "no-store"
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = new Error("Trusted wallet database request failed.");
        error.status = response.status;
        error.code = detail.code;
        error.details = detail.details;
        throw error;
    }
    const body = await response.text();
    return body ? JSON.parse(body) : [];
}

module.exports = {
    CYFUR_CREDITS_PER_TOKEN,
    authenticate,
    getDepositCreditAmount,
    getLevelEntryCostCredits,
    hasServiceDatabaseEnvironment,
    hasWalletEnvironment,
    serviceRequest,
    selectOwn,
    sendJson
};
