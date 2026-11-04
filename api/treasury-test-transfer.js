const { timingSafeEqual } = require("node:crypto");
const {
    handleApiCors,
    hasServiceDatabaseEnvironment,
    serviceRequest,
    sendJson
} = require("../server/lib/wallet");
const { getWithdrawalSignerFromEnvironment } = require("../server/lib/withdrawals");
const {
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS
} = require("../server/lib/solana-deposit");
const {
    CYFUR_TEST_AMOUNT_RAW,
    CYFUR_TEST_RECIPIENT,
    TOKEN_PROGRAM_ADDRESS,
    executeCyfurTreasuryTestTransfer
} = require("../server/lib/treasury-test-transfer");
const {
    createTreasuryTestTransferPreflightHandler
} = require("../server/lib/treasury-test-transfer-preflight");

const TRANSFER_ID = "cyfur-mainnet-one-cyfur-v1";
const CONFIRMATION_PHRASE = "SEND EXACTLY 1 CYFUR TO APPROVED TEST WALLET";

function isAuthorizedOwner(request, configuredToken) {
    if (typeof configuredToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(configuredToken)) return false;
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (typeof bearer !== "string") return false;
    const supplied = Buffer.from(bearer, "utf8");
    const expected = Buffer.from(configuredToken, "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function hasExpectedRequestBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const allowedKeys = ["amountRaw", "confirmation", "idempotencyKey", "recipient"];
    if (Object.keys(body).some((key) => !allowedKeys.includes(key))) return false;
    return body.recipient === CYFUR_TEST_RECIPIENT &&
        body.amountRaw === CYFUR_TEST_AMOUNT_RAW &&
        body.confirmation === CONFIRMATION_PHRASE &&
        typeof body.idempotencyKey === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotencyKey);
}

function sanitizeErrorMessage(message) {
    return String(message || "Unknown error")
        .replace(/https?:\/\/\S+/gi, "[redacted-url]")
        .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,100}\b/g, "[redacted-address]")
        .replace(/[A-Za-z0-9+/_-]{80,}={0,2}/g, "[redacted-data]")
        .slice(0, 250);
}

function createTreasuryTestTransferHandler({
    databaseConfigured = hasServiceDatabaseEnvironment,
    requestDatabase = serviceRequest,
    getSigner = getWithdrawalSignerFromEnvironment,
    executeTransfer = executeCyfurTreasuryTestTransfer,
    preflightHandler = createTreasuryTestTransferPreflightHandler()
} = {}) {
    return async function treasuryTestTransfer(request, response) {
        if (request.method === "GET") return preflightHandler(request, response);
        if (handleApiCors(request, response)) return;
        if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            return sendJson(response, 405, { error: "method_not_allowed" });
        }
        if (!isAuthorizedOwner(request, process.env.CYFUR_TEST_TRANSFER_OWNER_TOKEN)) {
            return sendJson(response, 401, { error: "owner_authorization_required" });
        }
        if (process.env.CYFUR_TEST_TRANSFER_ENABLED !== "true" ||
            process.env.VERCEL_ENV !== "production" ||
            process.env.SOLANA_NETWORK !== "mainnet-beta" ||
            !process.env.SOLANA_RPC_URL?.trim() ||
            !databaseConfigured()) {
            return sendJson(response, 503, { error: "test_transfer_not_configured" });
        }
        if (!hasExpectedRequestBody(request.body)) {
            return sendJson(response, 400, { error: "test_transfer_parameters_must_match_approved_values" });
        }

        let reserved = false;
        let submittedSignature = null;
        try {
            const configs = await requestDatabase(
                "wallet_system_config?select=network,official_mint_address,token_program_id,token_decimals,treasury_address&id=eq.1"
            );
            const config = configs[0];
            if (!config ||
                config.network !== "mainnet-beta" ||
                config.official_mint_address !== RELICGRID_CYFUR_MINT_ADDRESS ||
                config.token_program_id !== TOKEN_PROGRAM_ADDRESS ||
                config.token_decimals !== 8 ||
                config.treasury_address !== RELICGRID_TREASURY_ADDRESS) {
                return sendJson(response, 503, { error: "test_transfer_wallet_configuration_mismatch" });
            }

            const signer = getSigner();
            if (signer.publicKey.toBase58() !== RELICGRID_TREASURY_ADDRESS) {
                return sendJson(response, 503, { error: "test_transfer_signer_mismatch" });
            }

            const existing = await requestDatabase(
                `cyfur_treasury_test_transfers?select=transfer_id,status,transaction_signature,recipient_balance_raw,created_at&transfer_id=eq.${TRANSFER_ID}&limit=1`
            );
            if (existing.length) {
                return sendJson(response, 409, {
                    error: "test_transfer_already_reserved",
                    transfer: existing[0]
                });
            }

            const execution = await executeTransfer({
                treasurySigner: signer,
                onPrepared: async (preflight) => {
                    const inserted = await requestDatabase(
                        "cyfur_treasury_test_transfers?on_conflict=transfer_id",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                Prefer: "resolution=ignore-duplicates,return=representation"
                            },
                            body: JSON.stringify({
                                transfer_id: TRANSFER_ID,
                                idempotency_key: request.body.idempotencyKey,
                                network: "mainnet-beta",
                                mint_address: RELICGRID_CYFUR_MINT_ADDRESS,
                                token_program_id: TOKEN_PROGRAM_ADDRESS,
                                treasury_address: RELICGRID_TREASURY_ADDRESS,
                                recipient: CYFUR_TEST_RECIPIENT,
                                amount_raw: CYFUR_TEST_AMOUNT_RAW,
                                recipient_token_account: preflight.recipientTokenAccount,
                                recipient_account_existed: preflight.recipientTokenAccountExists,
                                recipient_balance_before_raw: preflight.recipientCyfurAmountRaw,
                                treasury_sol_lamports: preflight.treasurySolLamports,
                                treasury_token_balance_raw: preflight.treasuryCyfurAmountRaw,
                                required_rent_lamports: preflight.requiredRentLamports,
                                fee_lamports: preflight.feeLamports,
                                status: "reserved"
                            })
                        }
                    );
                    if (!inserted.some((row) => row.transfer_id === TRANSFER_ID)) {
                        const [prior] = await requestDatabase(
                            `cyfur_treasury_test_transfers?select=transfer_id,status,transaction_signature,recipient_balance_raw,created_at&transfer_id=eq.${TRANSFER_ID}&limit=1`
                        );
                        const duplicateError = new Error("The one-time treasury test transfer was already reserved.");
                        duplicateError.duplicate = true;
                        duplicateError.transfer = prior ?? null;
                        throw duplicateError;
                    }
                    reserved = true;
                },
                onSigned: async (signature) => {
                    const updated = await requestDatabase(
                        `cyfur_treasury_test_transfers?transfer_id=eq.${TRANSFER_ID}&status=eq.reserved`,
                        {
                            method: "PATCH",
                            headers: {
                                "Content-Type": "application/json",
                                Prefer: "return=representation"
                            },
                            body: JSON.stringify({
                                status: "submitted",
                                transaction_signature: signature
                            })
                        }
                    );
                    if (!updated.some((row) => row.transfer_id === TRANSFER_ID)) {
                        throw new Error("The signed transfer could not be durably recorded; it was not broadcast.");
                    }
                    submittedSignature = signature;
                }
            });

            const [confirmed] = await requestDatabase(
                `cyfur_treasury_test_transfers?transfer_id=eq.${TRANSFER_ID}&status=eq.submitted`,
                {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json",
                        Prefer: "return=representation"
                    },
                    body: JSON.stringify({
                        status: "confirmed",
                        recipient_balance_raw: execution.recipientCyfurAmountRaw,
                        confirmed_at: new Date().toISOString()
                    })
                }
            );
            if (!confirmed) {
                return sendJson(response, 202, {
                    status: "finalized_pending_database_confirmation",
                    signature: execution.signature,
                    recipient: CYFUR_TEST_RECIPIENT,
                    amountRaw: CYFUR_TEST_AMOUNT_RAW
                });
            }
            return sendJson(response, 200, {
                status: "confirmed",
                signature: execution.signature,
                recipient: CYFUR_TEST_RECIPIENT,
                amountRaw: CYFUR_TEST_AMOUNT_RAW,
                recipientBalanceRaw: execution.recipientCyfurAmountRaw,
                transactionUrl: `https://solscan.io/tx/${execution.signature}`
            });
        } catch (error) {
            if (error.duplicate) {
                return sendJson(response, 409, {
                    error: "test_transfer_already_reserved",
                    transfer: error.transfer
                });
            }
            if (submittedSignature || error.signature || reserved) {
                const signature = submittedSignature || error.signature || null;
                if (error.chainFailed === true) {
                    await requestDatabase(
                        `cyfur_treasury_test_transfers?transfer_id=eq.${TRANSFER_ID}&status=eq.submitted`,
                        {
                            method: "PATCH",
                            headers: {
                                "Content-Type": "application/json",
                                Prefer: "return=representation"
                            },
                            body: JSON.stringify({ status: "failed" })
                        }
                    );
                    return sendJson(response, 502, {
                        error: "test_transfer_failed_on_chain",
                        signature
                    });
                }
                if (error.finalized === true) {
                    await requestDatabase(
                        `cyfur_treasury_test_transfers?transfer_id=eq.${TRANSFER_ID}&status=eq.submitted`,
                        {
                            method: "PATCH",
                            headers: {
                                "Content-Type": "application/json",
                                Prefer: "return=representation"
                            },
                            body: JSON.stringify({ status: "finalized_unverified" })
                        }
                    );
                    return sendJson(response, 202, {
                        status: "finalized_unverified",
                        signature,
                        error: "recipient_balance_delta_mismatch"
                    });
                }
                return sendJson(response, 202, {
                    status: submittedSignature ? "submitted_pending_confirmation" : "reserved_no_retry",
                    signature
                });
            }
            console.error("CYFUR treasury test transfer could not be completed.", {
                code: error.code || "test_transfer_failed",
                message: sanitizeErrorMessage(error.message)
            });
            return sendJson(response, error.status === 503 ? 503 : 502, {
                error: "test_transfer_preflight_failed",
                message: sanitizeErrorMessage(error.message)
            });
        }
    };
}

module.exports = createTreasuryTestTransferHandler();
module.exports.createTreasuryTestTransferHandler = createTreasuryTestTransferHandler;
module.exports.isAuthorizedOwner = isAuthorizedOwner;
module.exports.hasExpectedRequestBody = hasExpectedRequestBody;
