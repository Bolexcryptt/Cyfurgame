const { getWithdrawalSignerFromEnvironment, parseWithdrawalSecret } = require("./withdrawals");
const {
    deriveAssociatedTokenAccount,
    GENESIS_HASHES,
    isOfficialCyfurMintAccount,
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS,
    solanaRpc
} = require("./solana-deposit");

function getTreasuryDiagnosticSummary() {
    const secretValue = process.env.WITHDRAWAL_TREASURY_PRIVATE_KEY?.trim() || process.env.TREASURY_PRIVATE_KEY?.trim();
    if (!secretValue) {
        return {
            present: false,
            configured: false,
            valid: false,
            reason: "WITHDRAWAL_TREASURY_PRIVATE_KEY is not set."
        };
    }

    try {
        const keypair = getWithdrawalSignerFromEnvironment();
        return {
            present: true,
            configured: true,
            valid: true,
            publicAddress: keypair.publicKey.toBase58()
        };
    } catch (error) {
        return {
            present: true,
            configured: true,
            valid: false,
            reason: "The treasury private key is present but could not be parsed as a valid Solana key."
        };
    }
}

function getWithdrawalGateSummary(config) {
    const vercelEnabled = process.env.WITHDRAWAL_ENABLED === "true";
    const supabaseEnabled = config?.withdrawals_enabled === true;
    return {
        vercelEnabled,
        supabaseEnabled,
        enabled: vercelEnabled && supabaseEnabled
    };
}

function getSupabaseError(responseText) {
    try {
        return JSON.parse(responseText);
    } catch {
        return null;
    }
}

async function getSupabaseWithdrawalConfig() {
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!supabaseUrl || !serviceRoleKey) {
        return {
            connected: false,
            reason: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured for a live check."
        };
    }

    try {
        const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/wallet_system_config?select=network,official_mint_address,treasury_address,token_program_id,token_decimals,credits_per_token,rounding_policy,deposits_enabled,withdrawals_enabled,paid_gameplay_enabled&id=eq.1`, {
            method: "GET",
            headers: {
                apikey: serviceRoleKey,
                Authorization: `Bearer ${serviceRoleKey}`,
                Accept: "application/json"
            },
            cache: "no-store"
        });

        if (!response.ok) {
            return {
                connected: false,
                status: response.status,
                reason: `Supabase configuration read failed with HTTP ${response.status}.`
            };
        }

        const rows = await response.json();
        return {
            connected: true,
            config: rows[0] ?? null
        };
    } catch (error) {
        return {
            connected: false,
            reason: "Unable to reach Supabase configuration. Check SUPABASE_URL, service-role configuration, and network connectivity."
        };
    }
}

async function verifyWithdrawalRpc() {
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!supabaseUrl || !serviceRoleKey) {
        return {
            available: false,
            reason: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured for the RPC check."
        };
    }

    const diagnosticPayload = {
        p_player_id: null,
        p_wallet_address: null,
        p_network: "mainnet-beta",
        p_mint_address: RELICGRID_CYFUR_MINT_ADDRESS,
        p_token_program_id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        p_treasury_address: RELICGRID_TREASURY_ADDRESS,
        p_amount_raw: 0,
        p_token_decimals: 8,
        p_amount_credits: 0,
        p_idempotency_key: "withdrawal-diagnostic-untrusted-check",
        p_memo: "diagnostic"
    };

    try {
        const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/reserve_wallet_withdrawal`, {
            method: "POST",
            headers: {
                apikey: serviceRoleKey,
                Authorization: `Bearer ${serviceRoleKey}`,
                "Content-Type": "application/json",
                Accept: "application/json"
            },
            body: JSON.stringify(diagnosticPayload),
            cache: "no-store"
        });

        const responseText = await response.text();
        const parsed = getSupabaseError(responseText);
        const message = typeof parsed?.message === "string" ? parsed.message : "";
        const responseCode = typeof parsed?.code === "string" ? parsed.code : null;
        const code = responseCode && /^(?:PGRST\d{3}|[A-Z0-9]{5})$/.test(responseCode)
            ? responseCode
            : null;
        const validationGuardHit = !response.ok &&
            /invalid withdrawal reservation/i.test(message);
        let reason;
        if (validationGuardHit) {
            reason = "The Supabase withdrawal RPC is reachable with service-role authorization; its expected invalid-input guard rejected the read-only diagnostic probe.";
        } else if (response.status === 404 || code === "PGRST202") {
            reason = "The Supabase withdrawal RPC was not found. Apply the withdrawal SQL migration and refresh the PostgREST schema cache.";
        } else if ([401, 403].includes(response.status) || code === "42501" ||
            /server authorization is required|permission denied/i.test(message)) {
            reason = "Supabase rejected the withdrawal RPC authorization. Verify SUPABASE_SERVICE_ROLE_KEY is configured for this API deployment and the RPC grants remain service-role only.";
        } else if (response.ok) {
            reason = "The invalid-input diagnostic probe unexpectedly succeeded. Do not use the withdrawal endpoint until the RPC validation guard is reviewed.";
        } else if (code === "PGRST202" || code === "PGRST205") {
            reason = "Supabase PostgREST could not resolve the withdrawal RPC. Apply the withdrawal SQL migration and refresh the schema cache.";
        } else if (response.status >= 500) {
            reason = `Supabase withdrawal RPC returned a server error (HTTP ${response.status}). Check the database function and Supabase logs.`;
        } else if (code) {
            reason = `Supabase withdrawal RPC rejected the diagnostic probe (HTTP ${response.status}, database code ${code}). Check the withdrawal migration, function signature, and database configuration.`;
        } else {
            reason = `Supabase withdrawal RPC returned an unexpected response (HTTP ${response.status}). Check the withdrawal migration and Supabase logs.`;
        }

        return {
            available: validationGuardHit,
            httpStatus: response.status,
            code,
            reason
        };
    } catch (error) {
        return {
            available: false,
            reason: "Unable to reach the Supabase withdrawal RPC. Check the Supabase URL, network connectivity, and service-role configuration."
        };
    }
}

async function verifyChainConfiguration(config) {
    const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
    const environmentNetwork = process.env.SOLANA_NETWORK?.trim() || null;
    const configNetwork = config?.network ?? null;
    const result = {
        available: false,
        healthCheckAvailable: false,
        health: null,
        networkVerified: false,
        mintVerified: false,
        treasuryTokenAccountVerified: false,
        configured: Boolean(rpcUrl),
        environmentNetwork,
        configNetwork,
        rpcNetwork: null,
        reason: null
    };
    if (!rpcUrl || !GENESIS_HASHES[configNetwork]) {
        result.reason = !rpcUrl
            ? "SOLANA_RPC_URL is not configured in this API deployment."
            : `The Supabase network value "${configNetwork}" is unsupported; use mainnet-beta for the production CYFUR mint.`;
        return result;
    }
    let rpcEndpoint;
    try {
        rpcEndpoint = new URL(rpcUrl);
    } catch {
        result.reason = "SOLANA_RPC_URL must be an absolute HTTPS URL.";
        return result;
    }
    if (rpcEndpoint.protocol !== "https:" || rpcEndpoint.username || rpcEndpoint.password) {
        result.reason = "SOLANA_RPC_URL must use HTTPS and must not contain embedded credentials.";
        return result;
    }

    try {
        const health = await solanaRpc(rpcUrl, "getHealth", []);
        result.health = typeof health === "string" ? health : "unexpected-response";
        result.healthCheckAvailable = health === "ok";
        if (!result.healthCheckAvailable) {
            result.reason = `Solana RPC getHealth returned "${result.health}" instead of "ok". Check provider health and Production endpoint configuration.`;
            return result;
        }

        const genesisHash = await solanaRpc(rpcUrl, "getGenesisHash", []);
        result.available = true;
        result.rpcNetwork = Object.entries(GENESIS_HASHES)
            .find(([, hash]) => hash === genesisHash)?.[0] ?? "unknown";
        result.networkVerified = result.rpcNetwork === configNetwork &&
            result.rpcNetwork === environmentNetwork &&
            result.rpcNetwork === "mainnet-beta";
        if (!result.networkVerified) {
            result.reason = `Solana RPC network is ${result.rpcNetwork}; SOLANA_NETWORK is ${environmentNetwork ?? "unset"}; Supabase network is ${configNetwork ?? "unset"}. All must be mainnet-beta.`;
            return result;
        }

        const [mintAccount, treasuryTokenAccount] = await Promise.all([
            solanaRpc(rpcUrl, "getAccountInfo", [
                config.official_mint_address,
                { commitment: "finalized", encoding: "jsonParsed" }
            ]),
            solanaRpc(rpcUrl, "getAccountInfo", [
                deriveAssociatedTokenAccount(
                    config.treasury_address,
                    config.official_mint_address,
                    config.token_program_id
                ),
                { commitment: "finalized", encoding: "jsonParsed" }
            ])
        ]);
        result.mintVerified = isOfficialCyfurMintAccount(mintAccount) &&
            config.token_program_id === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
            config.token_decimals === 8;
        const tokenInfo = treasuryTokenAccount?.value?.data?.parsed?.info;
        result.treasuryTokenAccountVerified = Boolean(
            treasuryTokenAccount?.value &&
            treasuryTokenAccount.value.owner === config.token_program_id &&
            treasuryTokenAccount.value.data?.parsed?.type === "account" &&
            tokenInfo?.mint === config.official_mint_address &&
            tokenInfo?.owner === config.treasury_address
        );
        if (!result.mintVerified) {
            result.reason = "The finalized RPC response does not verify the configured CYFUR mint, classic SPL Token program, and 8 decimals.";
        } else if (!result.treasuryTokenAccountVerified) {
            result.reason = "The finalized RPC response does not verify the treasury associated token account owner and CYFUR mint.";
        }
        return result;
    } catch (error) {
        if (Number.isInteger(error?.httpStatus)) {
            result.rpcHttpStatus = error.httpStatus;
        }
        if (error?.httpStatus === 401 || error?.httpStatus === 403) {
            result.reason = `Solana RPC returned HTTP ${error.httpStatus}; provider authentication was rejected. Check the Production RPC URL and provider API-key configuration.`;
        } else if (error?.httpStatus === 404) {
            result.rpcHttpStatus = 404;
            result.reason = "Solana RPC returned HTTP 404. The Production SOLANA_RPC_URL path is invalid or does not expose the Solana JSON-RPC endpoint.";
        } else if (error?.httpStatus === 429) {
            result.rpcHttpStatus = 429;
            result.reason = "Solana RPC returned HTTP 429. The provider rate limit or quota has been exceeded.";
        } else if (error?.httpStatus >= 500) {
            result.rpcHttpStatus = error.httpStatus;
            result.reason = `Solana RPC provider returned HTTP ${error.httpStatus}. Check the provider's service status.`;
        } else if (Number.isInteger(error?.httpStatus)) {
            result.rpcHttpStatus = error.httpStatus;
            result.reason = `Solana RPC returned unexpected HTTP ${error.httpStatus}. Check that SOLANA_RPC_URL points to a JSON-RPC endpoint.`;
        } else if (error?.transportCode && /TIMEOUT|TIMEDOUT|ETIMEDOUT|ABORT/i.test(error.transportCode)) {
            result.transportCode = error.transportCode;
            result.reason = "The Solana RPC request timed out. Check provider availability, latency, and Vercel Production egress.";
        } else if (error?.transportCode && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|CERT|TLS/i.test(error.transportCode)) {
            result.transportCode = error.transportCode;
            result.reason = "The Solana RPC hostname could not be resolved or its HTTPS connection failed. Check the Production endpoint hostname, DNS, and TLS configuration.";
        } else if (error?.invalidJson) {
            result.reason = "Solana RPC returned non-JSON data. Check the Production URL path and provider response format.";
        } else if (Number.isInteger(error?.rpcCode)) {
            result.rpcErrorCode = error.rpcCode;
            result.reason = `Solana RPC JSON-RPC error ${error.rpcCode} occurred during ${result.health === null ? "getHealth" : "getGenesisHash"}. Check provider access to standard Solana RPC methods.`;
        } else if (/connection failed/i.test(error?.message || "")) {
            result.reason = "Could not connect to the configured Solana RPC. Check the Production RPC URL, DNS/TLS access, and provider availability.";
        } else {
            result.reason = "The configured Solana RPC returned an invalid response. Check provider compatibility and Production environment configuration.";
        }
        return result;
    }
}

module.exports = {
    getSupabaseWithdrawalConfig,
    getTreasuryDiagnosticSummary,
    getWithdrawalGateSummary,
    verifyChainConfiguration,
    parseTreasurySecret: parseWithdrawalSecret,
    verifyWithdrawalRpc
};
