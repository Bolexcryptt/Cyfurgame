const { Keypair } = require("@solana/web3.js");
const { RELICGRID_CYFUR_MINT_ADDRESS, RELICGRID_TREASURY_ADDRESS } = require("./solana-deposit");

function parseTreasurySecret(secretValue) {
    if (typeof secretValue !== "string") {
        return null;
    }
    const trimmed = secretValue.trim();
    if (!trimmed) {
        return null;
    }

    let decoded = null;
    try {
        decoded = Buffer.from(trimmed, "base64");
        if (decoded.length === 64) return decoded;
    } catch {
        // Intentionally reject unsupported formats; deployments must provide real 64-byte keys.
    }

    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length === 64 && parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
            return Buffer.from(parsed);
        }
    } catch {
        // Intentionally reject unsupported formats; deployments must provide real 64-byte keys.
    }

    return null;
}

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

    const secretBytes = parseTreasurySecret(secretValue);
    if (!secretBytes || secretBytes.length !== 64) {
        return {
            present: true,
            configured: true,
            valid: false,
            reason: "The treasury private key is present but not a valid 64-byte Solana secret key."
        };
    }

    try {
        const keypair = Keypair.fromSecretKey(secretBytes);
        return {
            present: true,
            configured: true,
            valid: true,
            publicAddress: keypair.publicKey.toBase58(),
            secretLength: secretBytes.length
        };
    } catch (error) {
        return {
            present: true,
            configured: true,
            valid: false,
            reason: error?.message || "The treasury private key could not be loaded."
        };
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
        const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/wallet_system_config?select=network,official_mint_address,treasury_address,token_program_id,token_decimals,credits_per_token,rounding_policy,deposits_enabled,paid_gameplay_enabled&id=eq.1`, {
            method: "GET",
            headers: {
                apikey: serviceRoleKey,
                Authorization: `Bearer ${serviceRoleKey}`,
                Accept: "application/json"
            },
            cache: "no-store"
        });

        if (!response.ok) {
            const detail = await response.text();
            return {
                connected: false,
                status: response.status,
                reason: `Supabase read failed: ${detail.slice(0, 200)}`
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
            reason: error?.message || "Supabase connection check failed."
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
        p_player_id: "00000000-0000-0000-0000-000000000000",
        p_wallet_address: "11111111111111111111111111111111111111111111111111111111111111111",
        p_network: "mainnet-beta",
        p_transaction_signature: "11111111111111111111111111111111111111111111111111111111111111111",
        p_mint_address: RELICGRID_CYFUR_MINT_ADDRESS,
        p_token_program_id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        p_amount_raw: 0,
        p_token_decimals: 8,
        p_amount_credits: 0,
        p_idempotency_key: "withdrawal-diagnostic-untrusted-check",
        p_memo: "diagnostic"
    };

    try {
        const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/process_verified_withdrawal`, {
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
        let parsed = null;
        try {
            parsed = JSON.parse(responseText);
        } catch {
            parsed = null;
        }

        const message = parsed?.message || parsed?.details || responseText || "The RPC call returned no diagnostic details.";
        const hitValidationGuard = !response.ok && /invalid withdrawal payload|server authorization is required|insufficient credits|idempotency key|transaction signature/i.test(message);

        return {
            available: hitValidationGuard,
            httpStatus: response.status,
            message: message.slice(0, 300)
        };
    } catch (error) {
        return {
            available: false,
            reason: error?.message || "Unable to reach the withdrawal RPC."
        };
    }
}

function buildWithdrawalDiagnostic() {
    const treasurySummary = getTreasuryDiagnosticSummary();
    const configCheck = {
        expectedTreasuryAddress: RELICGRID_TREASURY_ADDRESS,
        expectedMintAddress: RELICGRID_CYFUR_MINT_ADDRESS,
        treasuryMatchesConfig: false,
        mintMatchesConfig: false,
        configLoaded: false,
        configNetwork: null,
        configTreasuryAddress: null,
        configMintAddress: null
    };

    return {
        ok: false,
        treasury: treasurySummary,
        config: configCheck,
        rpc: {
            available: false,
            reason: "Not checked yet."
        },
        supabase: {
            connected: false,
            reason: "Not checked yet."
        }
    };
}

module.exports = {
    buildWithdrawalDiagnostic,
    getSupabaseWithdrawalConfig,
    getTreasuryDiagnosticSummary,
    parseTreasurySecret,
    verifyWithdrawalRpc
};
