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

async function verifyChainConfiguration(config) {
    const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
    const network = config?.network;
    if (!rpcUrl || !GENESIS_HASHES[network]) {
        return {
            networkVerified: false,
            mintVerified: false,
            treasuryTokenAccountVerified: false,
            reason: "SOLANA_RPC_URL or a supported configured network is missing."
        };
    };

    try {
        const genesisHash = await solanaRpc(rpcUrl, "getGenesisHash", []);
        const networkVerified = genesisHash === GENESIS_HASHES[network];
        if (!networkVerified) {
            return {
                networkVerified: false,
                mintVerified: false,
                treasuryTokenAccountVerified: false,
                reason: "SOLANA_RPC_URL is connected to a different Solana network."
            };
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
        const mintVerified = isOfficialCyfurMintAccount(mintAccount) &&
            config.token_program_id === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
            config.token_decimals === 8;
        const tokenInfo = treasuryTokenAccount?.value?.data?.parsed?.info;
        const treasuryTokenAccountVerified = Boolean(
            treasuryTokenAccount?.value &&
            treasuryTokenAccount.value.owner === config.token_program_id &&
            treasuryTokenAccount.value.data?.parsed?.type === "account" &&
            tokenInfo?.mint === config.official_mint_address &&
            tokenInfo?.owner === config.treasury_address
        );
        return {
            networkVerified,
            mintVerified,
            treasuryTokenAccountVerified,
            reason: null
        };
    } catch (error) {
        return {
            networkVerified: false,
            mintVerified: false,
            treasuryTokenAccountVerified: false,
            reason: error?.message || "Unable to verify Solana network and token configuration."
        };
    }
}

module.exports = {
    getSupabaseWithdrawalConfig,
    getTreasuryDiagnosticSummary,
    verifyChainConfiguration,
    parseTreasurySecret: parseWithdrawalSecret,
    verifyWithdrawalRpc
};
