const {
    CYFUR_CREDITS_PER_TOKEN,
    authenticate,
    handleApiCors,
    hasWalletEnvironment,
    selectOwn,
    serviceRequest,
    sendJson
} = require("../server/lib/wallet");
const {
    deriveAssociatedTokenAccount,
    getApprovedCyfurMintAddress,
    GENESIS_HASHES,
    isOfficialCyfurMintAccount,
    isBase58,
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS,
    getSolanaNetwork,
    getSolanaRpcUrl,
    isDepositSettingEnabled,
    solanaRpc
} = require("../server/lib/solana-deposit");

function getAction(request) {
    if (typeof request.query?.action === "string") return request.query.action;
    return new URL(request.url || "/api/wallet", "https://relicgrid.invalid")
        .searchParams.get("action");
}

function isZeroCreditBalance(value) {
    if (typeof value === "number") return Number.isSafeInteger(value) && value === 0;
    return typeof value === "string" && /^\d+$/.test(value) && BigInt(value) === 0n;
}

async function getAccountRecoveryPreflight(playerId) {
    const encodedPlayerId = encodeURIComponent(playerId);
    const [
        profiles,
        accounts,
        completions,
        ledgerEntries,
        deposits,
        paymentIntents,
        linkedWallets,
        walletChallenges,
        withdrawals,
        levelSessions,
        depositAddresses
    ] = await Promise.all([
        serviceRequest(`player_profiles?select=id,display_name&id=eq.${encodedPlayerId}&limit=1`),
        serviceRequest(`wallet_credit_accounts?select=balance_credits&player_id=eq.${encodedPlayerId}&limit=1`),
        serviceRequest(`level_completions?select=player_id&player_id=eq.${encodedPlayerId}&limit=1`),
        serviceRequest(`wallet_credit_ledger?select=id&player_id=eq.${encodedPlayerId}&limit=1`),
        serviceRequest(`wallet_deposits?select=id&player_id=eq.${encodedPlayerId}&limit=1`),
        serviceRequest(`wallet_payment_intents?select=id&player_id=eq.${encodedPlayerId}&limit=1`),
        serviceRequest(`player_solana_wallets?select=player_id&player_id=eq.${encodedPlayerId}&limit=1`),
        serviceRequest(`wallet_link_challenges?select=player_id&player_id=eq.${encodedPlayerId}&limit=1`),
        serviceRequest(`wallet_withdrawals?select=id&player_id=eq.${encodedPlayerId}&limit=1`),
        serviceRequest(`wallet_level_sessions?select=id&player_id=eq.${encodedPlayerId}&limit=1`),
        serviceRequest(`player_deposit_addresses?select=player_id&player_id=eq.${encodedPlayerId}&limit=1`)
    ]);

    const profileReady = profiles.length === 1;
    const accountReady = accounts.length === 1 &&
        isZeroCreditBalance(accounts[0].balance_credits);
    if (!profileReady || !accountReady) {
        return {
            safeToRecover: false,
            reason: "identity_state_unavailable",
            message: "The current player account could not be safely checked. No account was changed."
        };
    }

    const hasPlayerData = Boolean(profiles[0].display_name?.trim()) ||
        [completions, ledgerEntries, deposits, paymentIntents, linkedWallets,
            walletChallenges, withdrawals, levelSessions, depositAddresses]
            .some((rows) => rows.length > 0);

    return {
        safeToRecover: !hasPlayerData,
        reason: hasPlayerData ? "current_identity_has_data" : null,
        message: hasPlayerData
            ? "This guest account already has player data. Link a recovery email to this account instead of switching identities."
            : null
    };
}

module.exports = async function wallet(request, response) {
    if (handleApiCors(request, response)) return;
    if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (!hasWalletEnvironment()) {
        return sendJson(response, 503, { error: "wallet_api_not_configured" });
    }

    try {
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });

        if (getAction(request) === "identity-recovery-preflight") {
            if (user.is_anonymous !== true) {
                return sendJson(response, 409, {
                    error: "account_recovery_requires_anonymous_session",
                    message: "Account recovery is only available from a new anonymous player session."
                });
            }
            if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
                return sendJson(response, 503, { error: "wallet_api_not_configured" });
            }
            return sendJson(
                response,
                200,
                await getAccountRecoveryPreflight(user.id)
            );
        }

        const [accounts, deposits, ledgerEntries] = await Promise.all([
            selectOwn(request, "wallet_credit_accounts", new URLSearchParams({
                select: "balance_credits,updated_at",
                limit: "1"
            })),
            selectOwn(request, "wallet_deposits", new URLSearchParams({
                select: "id,network,transaction_signature,amount_raw,token_decimals,status,credit_amount_credits,created_at,confirmed_at,failure_reason",
                order: "created_at.desc",
                limit: "20"
            })),
            selectOwn(request, "wallet_credit_ledger", new URLSearchParams({
                select: "balance_after_credits,created_at,id",
                order: "created_at.desc,id.desc",
                limit: "1"
            }))
        ]);
        let config = null;
        let linkedWalletAddress = null;
        if (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
            const [configs, linkedWallets] = await Promise.all([
                serviceRequest(
                    "wallet_system_config?select=deposits_enabled,paid_gameplay_enabled,network,official_mint_address,token_program_id,token_decimals,credits_per_token,rounding_policy,treasury_address&id=eq.1"
                ),
                serviceRequest(
                    `player_solana_wallets?select=wallet_address&player_id=eq.${encodeURIComponent(user.id)}&limit=1`
                )
            ]);
            config = configs[0] ?? null;
            if (isBase58(linkedWallets[0]?.wallet_address, 32)) {
                linkedWalletAddress = linkedWallets[0].wallet_address;
            }
        }
        const network = getSolanaNetwork();
        const approvedMintAddress = getApprovedCyfurMintAddress();
        const approvedTreasuryAddress = RELICGRID_TREASURY_ADDRESS;
        let treasuryAddress = null;
        let treasuryTokenAccountAddress = null;
        const readinessChecks = [];
        const addReadinessCheck = (code, message) => readinessChecks.push({ code, message });
        if (!GENESIS_HASHES[network]) {
            addReadinessCheck(
                "solana_network_unsupported",
                "The selected Solana network is not supported."
            );
        }
        if (config?.treasury_address !== RELICGRID_TREASURY_ADDRESS) {
            addReadinessCheck(
                "database_treasury_mismatch",
                "The configured treasury does not match the approved RelicGrid treasury address."
            );
        }
        if (!approvedMintAddress) {
            addReadinessCheck(
                "approved_mint_unconfigured",
                "The owner-confirmed official CYFUR mint has not been configured on the server."
            );
        } else if (network === "mainnet-beta" &&
            approvedMintAddress !== RELICGRID_CYFUR_MINT_ADDRESS) {
            addReadinessCheck(
                "approved_mint_not_application_mint",
                "The approved mainnet mint does not match the CYFUR mint supported by this application."
            );
        } else if (config?.official_mint_address !== approvedMintAddress) {
            addReadinessCheck(
                "database_mint_mismatch",
                "The configured CYFUR mint does not match the owner-confirmed official mint."
            );
        }
        if (!config ||
            !config.official_mint_address ||
            !config.token_program_id ||
            !Number.isInteger(config.token_decimals) ||
            String(config.credits_per_token) !== String(CYFUR_CREDITS_PER_TOKEN) ||
            config.rounding_policy !== "floor" ||
            config.network !== network ||
            !config?.treasury_address) {
            addReadinessCheck(
                "database_wallet_configuration_incomplete",
                "Wallet database configuration must match the selected Solana network and CYFUR settings."
            );
        }
        if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
            addReadinessCheck(
                "service_database_key_missing",
                "The server-side wallet database connection is not configured."
            );
        }
        if (
            GENESIS_HASHES[network] &&
            config?.network === network &&
            isBase58(approvedTreasuryAddress, 32) &&
            config?.treasury_address === approvedTreasuryAddress) {
            let genesisHash;
            let treasuryAccount;
            let mintAccount;
            try {
                [genesisHash, treasuryAccount, mintAccount] = await Promise.all([
                    solanaRpc(getSolanaRpcUrl(), "getGenesisHash", []),
                    solanaRpc(getSolanaRpcUrl(), "getAccountInfo", [approvedTreasuryAddress, {
                        commitment: "finalized",
                        encoding: "base64"
                    }]),
                    solanaRpc(getSolanaRpcUrl(), "getAccountInfo", [config.official_mint_address, {
                        commitment: "finalized",
                        encoding: "jsonParsed"
                    }])
                ]);
            } catch (error) {
                console.error("Wallet deposit readiness Solana check failed.", {
                    network,
                    code: error.code ?? "solana_readiness_rpc_failed",
                    rpcCode: Number.isInteger(error.rpcCode) ? error.rpcCode : null
                });
                throw error;
            }
            if (genesisHash !== GENESIS_HASHES[network]) {
                addReadinessCheck(
                    "solana_rpc_network_mismatch",
                    "SOLANA_RPC_URL is connected to a different Solana network."
                );
            } else if (treasuryAccount?.value &&
                treasuryAccount.value.owner !== "11111111111111111111111111111111") {
                addReadinessCheck(
                    "treasury_authority_invalid",
                    "The configured treasury address is not a System Program-owned wallet authority; token accounts are not valid treasury wallets."
                );
            } else if (config.network === "mainnet-beta"
                ? !isOfficialCyfurMintAccount(mintAccount) ||
                    config.token_program_id !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
                    config.token_decimals !== 8
                : !mintAccount?.value ||
                    mintAccount.value.owner !== config.token_program_id ||
                    mintAccount.value.data?.parsed?.type !== "mint" ||
                    mintAccount.value.data?.parsed?.info?.decimals !== config.token_decimals) {
                addReadinessCheck(
                    "mint_account_verification_failed",
                    "The configured CYFUR mint metadata, token program, decimals, or revoked authorities do not match finalized Solana account data."
                );
            } else {
                try {
                    treasuryTokenAccountAddress = deriveAssociatedTokenAccount(
                        approvedTreasuryAddress,
                        config.official_mint_address,
                        config.token_program_id
                    );
                    const treasuryTokenAccount = await solanaRpc(
                        getSolanaRpcUrl(),
                        "getAccountInfo",
                        [treasuryTokenAccountAddress, {
                            commitment: "finalized",
                            encoding: "jsonParsed"
                        }]
                    );
                    const tokenInfo = treasuryTokenAccount?.value?.data?.parsed?.info;
                    if (!treasuryTokenAccount?.value ||
                        treasuryTokenAccount.value.owner !== config.token_program_id ||
                        treasuryTokenAccount.value.data?.parsed?.type !== "account" ||
                        tokenInfo?.mint !== config.official_mint_address ||
                        tokenInfo?.owner !== approvedTreasuryAddress) {
                        addReadinessCheck(
                            "treasury_token_account_invalid",
                            "The treasury CYFUR associated token account is missing or does not match the configured authority and mint."
                        );
                        treasuryTokenAccountAddress = null;
                    } else {
                        treasuryAddress = approvedTreasuryAddress;
                    }
                } catch (error) {
                    if (error instanceof TypeError) {
                        addReadinessCheck(
                            "treasury_token_account_derivation_failed",
                            "The configured treasury address cannot own a standard associated token account."
                        );
                        treasuryTokenAccountAddress = null;
                    } else {
                        throw error;
                    }
                }
            }
        }
        if (!isDepositSettingEnabled("WALLET_DIRECT_TREASURY_READY")) {
            addReadinessCheck(
                "direct_treasury_acknowledgement_missing",
                "Direct-to-treasury deposits are disabled by a server override."
            );
        }
        if (config?.deposits_enabled !== true) {
            addReadinessCheck(
                "database_deposits_disabled",
                "Deposits are disabled in the wallet database configuration."
            );
        }
        if (!isDepositSettingEnabled("WALLET_DEPOSITS_ENABLED")) {
            addReadinessCheck(
                "server_deposits_flag_disabled",
                "Deposit verification is disabled by a server override."
            );
        }
        if (network === "mainnet-beta" &&
            !isDepositSettingEnabled("WALLET_MAINNET_DEPOSITS_ENABLED")) {
            addReadinessCheck(
                "server_mainnet_deposits_flag_disabled",
                "Mainnet deposit verification is disabled by a server override."
            );
        }
        const depositsEnabled = readinessChecks.length === 0;
        if (!depositsEnabled) {
            console.warn("Wallet deposit readiness checks failed.", {
                network: network ?? null,
                failedChecks: readinessChecks.map(({ code }) => code)
            });
        }
        const accountBalance = accounts[0]?.balance_credits;
        const lastLedgerBalance = ledgerEntries[0]?.balance_after_credits;
        const storedBalance = accountBalance ??
            lastLedgerBalance ??
            (accounts.length === 0 && ledgerEntries.length === 0 ? "0" : null);
        const balanceVerified = (typeof storedBalance === "string" && /^\d+$/.test(storedBalance)) ||
            (typeof storedBalance === "number" && Number.isSafeInteger(storedBalance) && storedBalance >= 0);
        const paidGameplayEnabled =
            config?.paid_gameplay_enabled === true &&
            process.env.WALLET_PAID_GAMEPLAY_ENABLED === "true" &&
            Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());

        return sendJson(response, 200, {
            depositsEnabled,
            paidGameplayEnabled,
            fundingStatus: depositsEnabled ? "ready" : "disabled",
            network: network ?? null,
            disabledReason: depositsEnabled ? null : "direct_treasury_setup_incomplete",
            disabledMessage: depositsEnabled
                ? "Deposit verification is ready. Create deposit instructions, send the displayed amount with its unique memo, then submit the transaction link. RelicGrid verifies finality before crediting."
                : `${readinessChecks.map(({ message }) => message).join(" ")} Do not send CYFUR until the status is READY.`,
            exchangeRateCreditsPerToken: CYFUR_CREDITS_PER_TOKEN,
            treasuryAddress,
            treasuryTokenAccountAddress,
            officialMintAddress: config?.official_mint_address ?? null,
            tokenProgramId: config?.token_program_id ?? null,
            tokenDecimals: Number.isInteger(config?.token_decimals) ? config.token_decimals : null,
            linkedWalletAddress,
            balanceCredits: balanceVerified ? String(storedBalance) : null,
            balanceVerified,
            deposits
        });
    } catch (error) {
        console.error("Wallet data request failed.", {
            status: error.status ?? 500,
            code: error.code ?? "wallet_request_failed"
        });
        if (error.status === 404 && error.code === "PGRST205") {
            return sendJson(response, 503, { error: "wallet_schema_not_installed" });
        }
        return sendJson(response, 502, { error: "wallet_data_unavailable" });
    }
};
