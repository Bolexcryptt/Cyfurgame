const {
    getSupabaseWithdrawalConfig,
    getTreasuryDiagnosticSummary,
    getWithdrawalGateSummary,
    verifyChainConfiguration,
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
    const withdrawalGates = getWithdrawalGateSummary(configData);
    const signerMatchesConfig = Boolean(treasurySummary.publicAddress) &&
        treasurySummary.publicAddress === configData?.treasury_address;
    const signerMatchesExpected = treasurySummary.publicAddress === RELICGRID_TREASURY_ADDRESS;
    const treasuryMatches = Boolean(configData?.treasury_address) &&
        configData.treasury_address === RELICGRID_TREASURY_ADDRESS;
    const mintMatches = Boolean(configData?.official_mint_address) && configData.official_mint_address === RELICGRID_CYFUR_MINT_ADDRESS;
    const expectedNetwork = "mainnet-beta";
    const environmentNetwork = process.env.SOLANA_NETWORK?.trim() || null;
    const networkConfigurationMatches = configData?.network === expectedNetwork &&
        environmentNetwork === expectedNetwork;
    const chainResult = configData ? await verifyChainConfiguration(configData) : {
        available: false,
        configured: Boolean(process.env.SOLANA_RPC_URL?.trim()),
        environmentNetwork,
        configNetwork: null,
        rpcNetwork: null,
        networkVerified: false,
        mintVerified: false,
        treasuryTokenAccountVerified: false,
        reason: "Supabase wallet configuration was not loaded."
    };
    const overallReady = treasurySummary.valid && signerMatchesConfig &&
        signerMatchesExpected && configResult.connected && rpcResult.available &&
        treasuryMatches && mintMatches && networkConfigurationMatches &&
        chainResult.networkVerified && chainResult.mintVerified &&
        chainResult.treasuryTokenAccountVerified && withdrawalGates.enabled &&
        withdrawalGates.rateLimitConfigured;

    return sendJson(response, 200, {
        ok: overallReady,
        secrets: {
            treasuryPrivateKeyPresent: treasurySummary.present,
            treasuryPrivateKeyValid: treasurySummary.valid,
            treasuryPublicAddress: treasurySummary.publicAddress ?? null,
            treasuryPublicAddressMatchesConfig: signerMatchesConfig,
            treasuryPublicAddressMatchesExpected: signerMatchesExpected,
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
            withdrawalsEnabled: withdrawalGates.supabaseEnabled,
            paidGameplayEnabled: configData?.paid_gameplay_enabled ?? null,
            creditsPerToken: configData?.credits_per_token ?? null,
            roundingPolicy: configData?.rounding_policy ?? null,
            withdrawalRateLimitPerHour: withdrawalGates.rateLimitPerHour,
            withdrawalRateLimitConfigured: withdrawalGates.rateLimitConfigured,
            reason: configResult.reason ?? null
        },
        chain: {
            available: chainResult.available,
            rpcUrlConfigured: chainResult.configured,
            environmentNetwork: chainResult.environmentNetwork,
            supabaseNetwork: chainResult.configNetwork,
            rpcNetwork: chainResult.rpcNetwork,
            rpcHttpStatus: chainResult.rpcHttpStatus ?? null,
            rpcErrorCode: chainResult.rpcErrorCode ?? null,
            networkVerified: chainResult.networkVerified,
            mintVerified: chainResult.mintVerified,
            treasuryTokenAccountVerified: chainResult.treasuryTokenAccountVerified,
            reason: chainResult.reason
        },
        rpc: {
            available: chainResult.available,
            healthCheckAvailable: chainResult.healthCheckAvailable,
            health: chainResult.health,
            network: chainResult.rpcNetwork,
            httpStatus: chainResult.rpcHttpStatus ?? null,
            jsonRpcErrorCode: chainResult.rpcErrorCode ?? null,
            reason: chainResult.reason
        },
        supabaseWithdrawalRpc: {
            available: rpcResult.available,
            httpStatus: rpcResult.httpStatus ?? null,
            databaseCode: rpcResult.code ?? null,
            reason: rpcResult.reason ?? null
        },
        checks: {
            treasuryPrivateKey: treasurySummary.valid,
            signerMatchesConfig: signerMatchesConfig,
            signerMatchesExpectedTreasury: signerMatchesExpected,
            configMatchesTreasury: treasuryMatches,
            configMatchesMint: mintMatches,
            networkMatches: networkConfigurationMatches && chainResult.networkVerified,
            environmentNetwork: environmentNetwork,
            environmentNetworkMatchesExpected: environmentNetwork === expectedNetwork,
            supabaseNetwork: configData?.network ?? null,
            supabaseNetworkMatchesExpected: configData?.network === expectedNetwork,
            rpcNetwork: chainResult.rpcNetwork,
            rpcNetworkMatchesExpected: chainResult.rpcNetwork === expectedNetwork,
            solanaRpcAvailable: chainResult.available,
            solanaRpcUrlConfigured: chainResult.configured,
            mintVerifiedOnChain: chainResult.mintVerified,
            treasuryTokenAccountVerified: chainResult.treasuryTokenAccountVerified,
            supabaseConnected: configResult.connected,
            withdrawalRpcAvailable: rpcResult.available,
            vercelWithdrawalEnabled: withdrawalGates.vercelEnabled,
            supabaseWithdrawalsEnabled: withdrawalGates.supabaseEnabled,
            withdrawalRateLimitPerHour: withdrawalGates.rateLimitPerHour,
            withdrawalRateLimitConfigured: withdrawalGates.rateLimitConfigured,
            withdrawalsEnabled: withdrawalGates.enabled
        },
        notes: [
            "The private key itself is never returned in the response.",
            "The deployment must match the owner-approved treasury and CYFUR mint before any real payout is enabled.",
            "The Supabase withdrawals_enabled flag and Vercel WITHDRAWAL_ENABLED flag must both be explicitly enabled before a payout can be reserved."
        ],
        expected: {
            treasuryAddress: RELICGRID_TREASURY_ADDRESS,
            officialCyfurMintAddress: RELICGRID_CYFUR_MINT_ADDRESS,
            network: expectedNetwork
        }
    });
};
