const {
    buildWithdrawalDiagnostic,
    getSupabaseWithdrawalConfig,
    getTreasuryDiagnosticSummary,
    verifyWithdrawalRpc
} = require("../server/lib/withdrawal-diagnostics");
const { RELICGRID_CYFUR_MINT_ADDRESS, RELICGRID_TREASURY_ADDRESS } = require("../server/lib/solana-deposit");
const { sendJson } = require("../server/lib/wallet");

module.exports = async function withdrawalDiagnostics(request, response) {
    if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }

    const configuredSecret = process.env.WITHDRAWAL_DIAGNOSTIC_SECRET?.trim();
    const providedSecret = request.headers["x-diagnostic-key"] || request.headers["x-withdrawal-diagnostic-key"] || request.headers.authorization;

    if (!configuredSecret) {
        return sendJson(response, 503, {
            error: "diagnostic_not_configured",
            message: "Set WITHDRAWAL_DIAGNOSTIC_SECRET in Vercel to enable the deployment diagnostic endpoint."
        });
    }

    if (!providedSecret || providedSecret !== configuredSecret) {
        return sendJson(response, 401, { error: "diagnostic_auth_required" });
    }

    const treasurySummary = getTreasuryDiagnosticSummary();
    const configResult = await getSupabaseWithdrawalConfig();
    const rpcResult = await verifyWithdrawalRpc();

    const configData = configResult.config ?? null;
    const treasuryMatches = Boolean(configData?.treasury_address) && configData.treasury_address === RELICGRID_TREASURY_ADDRESS;
    const mintMatches = Boolean(configData?.official_mint_address) && configData.official_mint_address === RELICGRID_CYFUR_MINT_ADDRESS;
    const networkMatches = configData?.network ? configData.network === process.env.SOLANA_NETWORK : false;
    const overallReady = treasurySummary.valid && configResult.connected && rpcResult.available && treasuryMatches && mintMatches && networkMatches;

    return sendJson(response, 200, {
        ok: overallReady,
        secrets: {
            treasuryPrivateKeyPresent: treasurySummary.present,
            treasuryPrivateKeyValid: treasurySummary.valid,
            treasuryPublicAddress: treasurySummary.publicAddress ?? null,
            treasuryPublicAddressMatchesConfig: treasuryMatches,
            treasuryPublicAddressExpected: RELICGRID_TREASURY_ADDRESS
        },
        config: {
            loaded: configResult.connected,
            network: configData?.network ?? null,
            treasuryAddress: configData?.treasury_address ?? null,
            treasuryAddressMatchesExpected: treasuryMatches,
            officialMintAddress: configData?.official_mint_address ?? null,
            officialMintMatchesExpected: mintMatches,
            tokenDecimals: configData?.token_decimals ?? null,
            tokenProgramId: configData?.token_program_id ?? null,
            depositsEnabled: configData?.deposits_enabled ?? null,
            paidGameplayEnabled: configData?.paid_gameplay_enabled ?? null,
            creditsPerToken: configData?.credits_per_token ?? null,
            roundingPolicy: configData?.rounding_policy ?? null,
            reason: configResult.reason ?? null
        },
        rpc: {
            available: rpcResult.available,
            httpStatus: rpcResult.httpStatus ?? null,
            message: rpcResult.message ?? rpcResult.reason ?? null
        },
        checks: {
            treasuryPrivateKey: treasurySummary.valid,
            configMatchesTreasury: treasuryMatches,
            configMatchesMint: mintMatches,
            networkMatches: networkMatches,
            supabaseConnected: configResult.connected,
            withdrawalRpcAvailable: rpcResult.available
        },
        notes: [
            "The private key itself is never returned in the response.",
            "The deployment must match the owner-approved treasury and CYFUR mint before any real payout is enabled."
        ],
        expected: {
            treasuryAddress: RELICGRID_TREASURY_ADDRESS,
            officialCyfurMintAddress: RELICGRID_CYFUR_MINT_ADDRESS,
            network: process.env.SOLANA_NETWORK || null
        }
    });
};
