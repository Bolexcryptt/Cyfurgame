const { timingSafeEqual } = require("node:crypto");
const {
    handleApiCors,
    hasServiceDatabaseEnvironment,
    serviceRequest,
    sendJson
} = require("./wallet");
const { getWithdrawalSignerFromEnvironment } = require("./withdrawals");
const {
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS
} = require("./solana-deposit");
const {
    CYFUR_TEST_AMOUNT_RAW,
    CYFUR_TEST_RECIPIENT,
    TOKEN_PROGRAM_ADDRESS,
    readCyfurTreasuryTestPreflight
} = require("./treasury-test-transfer");

const TRANSFER_ID = "cyfur-mainnet-one-cyfur-v1";

function isAuthorizedOwner(request, configuredToken) {
    if (typeof configuredToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(configuredToken)) return false;
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (typeof bearer !== "string") return false;
    const supplied = Buffer.from(bearer, "utf8");
    const expected = Buffer.from(configuredToken, "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function createTreasuryTestTransferPreflightHandler({
    databaseConfigured = hasServiceDatabaseEnvironment,
    requestDatabase = serviceRequest,
    getSigner = getWithdrawalSignerFromEnvironment,
    readChain = readCyfurTreasuryTestPreflight
} = {}) {
    return async function treasuryTestTransferPreflight(request, response) {
        if (handleApiCors(request, response)) return;
        if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            return sendJson(response, 405, { error: "method_not_allowed" });
        }
        if (!isAuthorizedOwner(request, process.env.CYFUR_TEST_TRANSFER_OWNER_TOKEN)) {
            return sendJson(response, 401, { error: "owner_authorization_required" });
        }

        const checks = {
            ownerTokenVerified: true,
            testTransferEnabled: process.env.CYFUR_TEST_TRANSFER_ENABLED === "true",
            productionEnvironment: process.env.VERCEL_ENV === "production",
            mainnetConfigured: process.env.SOLANA_NETWORK === "mainnet-beta",
            rpcUrlConfigured: Boolean(process.env.SOLANA_RPC_URL?.trim()),
            serviceRoleEnvironmentConfigured: databaseConfigured(),
            configurationMatchesApprovedValues: false,
            supabaseTestTableAccessible: false,
            signerMatchesTreasury: false,
            rpcMainnetVerified: false,
            mintVerified: false,
            treasuryTokenAccountVerified: false,
            recipientTokenAccountVerified: false,
            oneTimeTransferRecordExists: null,
            enoughTreasuryCyfur: false,
            enoughTreasurySol: false
        };
        const result = {
            readyToExecute: false,
            readOnly: true,
            transactionSubmitted: false,
            signature: null,
            checks,
            approvedTransfer: {
                network: "mainnet-beta",
                mintAddress: RELICGRID_CYFUR_MINT_ADDRESS,
                treasuryAddress: RELICGRID_TREASURY_ADDRESS,
                recipient: CYFUR_TEST_RECIPIENT,
                amountRaw: CYFUR_TEST_AMOUNT_RAW,
                tokenProgramAddress: TOKEN_PROGRAM_ADDRESS,
                tokenDecimals: 8
            }
        };

        if (!checks.testTransferEnabled ||
            !checks.productionEnvironment ||
            !checks.mainnetConfigured ||
            !checks.rpcUrlConfigured ||
            !checks.serviceRoleEnvironmentConfigured) {
            return sendJson(response, 200, result);
        }

        try {
            const configs = await requestDatabase(
                "wallet_system_config?select=network,official_mint_address,token_program_id,token_decimals,treasury_address&id=eq.1"
            );
            const config = configs[0];
            checks.configurationMatchesApprovedValues = Boolean(config) &&
                config.network === "mainnet-beta" &&
                config.official_mint_address === RELICGRID_CYFUR_MINT_ADDRESS &&
                config.token_program_id === TOKEN_PROGRAM_ADDRESS &&
                config.token_decimals === 8 &&
                config.treasury_address === RELICGRID_TREASURY_ADDRESS;
            if (!checks.configurationMatchesApprovedValues) {
                result.blocker = "supabase_wallet_configuration_mismatch";
                return sendJson(response, 200, result);
            }

            const records = await requestDatabase(
                `cyfur_treasury_test_transfers?select=transfer_id,status,transaction_signature,recipient_balance_raw,created_at&transfer_id=eq.${TRANSFER_ID}&limit=1`
            );
            checks.supabaseTestTableAccessible = true;
            checks.oneTimeTransferRecordExists = records.length > 0;
            if (checks.oneTimeTransferRecordExists) {
                result.existingTransfer = records[0];
                result.blocker = "one_time_transfer_already_reserved";
                return sendJson(response, 200, result);
            }

            const signer = getSigner();
            checks.signerMatchesTreasury =
                signer.publicKey.toBase58() === RELICGRID_TREASURY_ADDRESS;
            if (!checks.signerMatchesTreasury) {
                result.blocker = "treasury_signer_mismatch";
                return sendJson(response, 200, result);
            }

            const chain = await readChain({ treasurySigner: signer });
            checks.rpcMainnetVerified = chain.network === "mainnet-beta" &&
                chain.genesisHash === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
            checks.mintVerified = chain.mintAddress === RELICGRID_CYFUR_MINT_ADDRESS &&
                chain.tokenProgramAddress === TOKEN_PROGRAM_ADDRESS &&
                chain.tokenDecimals === 8;
            checks.treasuryTokenAccountVerified = chain.treasuryAddress === RELICGRID_TREASURY_ADDRESS &&
                typeof chain.treasuryCyfurAmountRaw === "string";
            checks.recipientTokenAccountVerified = chain.recipient === CYFUR_TEST_RECIPIENT &&
                typeof chain.recipientTokenAccount === "string";
            checks.enoughTreasuryCyfur = chain.enoughCyfur === true;
            checks.enoughTreasurySol = chain.enoughSol === true;
            result.chain = {
                commitment: "finalized",
                treasurySolLamports: chain.treasurySolLamports,
                treasuryCyfurAmountRaw: chain.treasuryCyfurAmountRaw,
                treasuryTokenAccount: chain.treasuryTokenAccount,
                recipientTokenAccount: chain.recipientTokenAccount,
                recipientTokenAccountExists: chain.recipientTokenAccountExists,
                recipientCyfurAmountRaw: chain.recipientCyfurAmountRaw,
                currentAtaRentLamports: chain.currentAtaRentLamports,
                estimatedFeeLamports: chain.estimatedFeeLamports,
                requiredSolLamports: chain.requiredSolLamports,
                amountRaw: CYFUR_TEST_AMOUNT_RAW
            };

            result.readyToExecute = Object.entries(checks)
                .filter(([name]) => name !== "oneTimeTransferRecordExists")
                .every(([, passed]) => passed === true) &&
                checks.oneTimeTransferRecordExists === false;
            if (checks.oneTimeTransferRecordExists) {
                result.blocker = "one_time_transfer_already_reserved";
            } else if (!checks.enoughTreasuryCyfur) {
                result.blocker = "insufficient_treasury_cyfur";
            } else if (!checks.enoughTreasurySol) {
                result.blocker = "insufficient_treasury_sol";
            }
            return sendJson(response, 200, result);
        } catch (error) {
            result.readyToExecute = false;
            result.blocker = "preflight_check_failed";
            result.errorCode = typeof error.code === "string" ? error.code : null;
            console.error("CYFUR read-only treasury preflight failed.", {
                stage: checks.supabaseTestTableAccessible ? "solana_or_signer_check" : "supabase_read",
                code: result.errorCode || "preflight_failed"
            });
            return sendJson(response, 503, result);
        }
    };
}

module.exports.createTreasuryTestTransferPreflightHandler = createTreasuryTestTransferPreflightHandler;
module.exports.isAuthorizedOwner = isAuthorizedOwner;
