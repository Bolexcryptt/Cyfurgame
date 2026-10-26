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
    GENESIS_HASHES,
    isOfficialCyfurMintAccount,
    isBase58,
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS,
    solanaRpc
} = require("../server/lib/solana-deposit");

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
        if (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
            const configs = await serviceRequest(
                "wallet_system_config?select=deposits_enabled,paid_gameplay_enabled,network,official_mint_address,token_program_id,token_decimals,credits_per_token,rounding_policy,treasury_address&id=eq.1"
            );
            config = configs[0] ?? null;
        }
        const network = process.env.SOLANA_NETWORK;
        const linkedWalletAddress = null;
        const approvedTreasuryAddress = RELICGRID_TREASURY_ADDRESS;
        let treasuryAddress = null;
        let treasuryTokenAccountAddress = null;
        const readinessChecks = [];
        if (config?.treasury_address !== RELICGRID_TREASURY_ADDRESS) {
            readinessChecks.push("The configured treasury does not match the approved RelicGrid treasury address.");
        }
        if (config?.official_mint_address !== RELICGRID_CYFUR_MINT_ADDRESS) {
            readinessChecks.push("The configured CYFUR mint does not match the owner-verified production mint.");
        }
        if (!config ||
            !config.official_mint_address ||
            !config.token_program_id ||
            !Number.isInteger(config.token_decimals) ||
            String(config.credits_per_token) !== String(CYFUR_CREDITS_PER_TOKEN) ||
            config.rounding_policy !== "floor" ||
            config.network !== network ||
            !config?.treasury_address) {
            readinessChecks.push("Supabase wallet configuration must match the selected Solana network and CYFUR settings.");
        }
        if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
            readinessChecks.push("Set SUPABASE_SERVICE_ROLE_KEY in Vercel.");
        }
        if (!process.env.SOLANA_RPC_URL?.trim()) {
            readinessChecks.push("Set SOLANA_RPC_URL in Vercel.");
        }
        if (process.env.SOLANA_RPC_URL?.trim() &&
            GENESIS_HASHES[network] &&
            config?.network === network &&
            isBase58(approvedTreasuryAddress, 32) &&
            config?.treasury_address === approvedTreasuryAddress) {
            const [genesisHash, treasuryAccount, mintAccount] = await Promise.all([
                solanaRpc(process.env.SOLANA_RPC_URL, "getGenesisHash", []),
                solanaRpc(process.env.SOLANA_RPC_URL, "getAccountInfo", [approvedTreasuryAddress, {
                    commitment: "finalized",
                    encoding: "base64"
                }]),
                solanaRpc(process.env.SOLANA_RPC_URL, "getAccountInfo", [config.official_mint_address, {
                    commitment: "finalized",
                    encoding: "jsonParsed"
                }])
            ]);
            if (genesisHash !== GENESIS_HASHES[network]) {
                readinessChecks.push("SOLANA_RPC_URL is connected to a different Solana network.");
            } else if (treasuryAccount?.value &&
                treasuryAccount.value.owner !== "11111111111111111111111111111111") {
                readinessChecks.push("The configured treasury address is not a System Program-owned wallet authority; token accounts are not valid treasury wallets.");
            } else if (config.network === "mainnet-beta"
                ? !isOfficialCyfurMintAccount(mintAccount) ||
                    config.token_program_id !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
                    config.token_decimals !== 8
                : !mintAccount?.value ||
                    mintAccount.value.owner !== config.token_program_id ||
                    mintAccount.value.data?.parsed?.type !== "mint" ||
                    mintAccount.value.data?.parsed?.info?.decimals !== config.token_decimals) {
                readinessChecks.push("The configured CYFUR mint metadata, token program, decimals, or revoked authorities do not match finalized Solana mainnet account data.");
            } else {
                try {
                    treasuryTokenAccountAddress = deriveAssociatedTokenAccount(
                        approvedTreasuryAddress,
                        config.official_mint_address,
                        config.token_program_id
                    );
                    const treasuryTokenAccount = await solanaRpc(
                        process.env.SOLANA_RPC_URL,
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
                        readinessChecks.push("The treasury CYFUR associated token account is missing or does not match the configured authority and mint.");
                        treasuryTokenAccountAddress = null;
                    } else {
                        treasuryAddress = approvedTreasuryAddress;
                    }
                } catch (error) {
                    if (error instanceof TypeError) {
                        readinessChecks.push("The configured treasury address cannot own a standard associated token account.");
                        treasuryTokenAccountAddress = null;
                    } else {
                        throw error;
                    }
                }
            }
        }
        if (process.env.WALLET_DIRECT_TREASURY_READY !== "true") {
            readinessChecks.push("Set WALLET_DIRECT_TREASURY_READY=true in Vercel.");
        }
        if (config?.deposits_enabled !== true) {
            readinessChecks.push("Set wallet_system_config.deposits_enabled=true in Supabase after approval.");
        }
        if (process.env.WALLET_DEPOSITS_ENABLED !== "true") {
            readinessChecks.push("Set WALLET_DEPOSITS_ENABLED=true in Vercel after approval.");
        }
        if (network === "mainnet-beta" &&
            process.env.WALLET_MAINNET_DEPOSITS_ENABLED !== "true") {
            readinessChecks.push("Set WALLET_MAINNET_DEPOSITS_ENABLED=true in Vercel after mainnet approval.");
        }
        const depositsEnabled = readinessChecks.length === 0;
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
                ? "Deposit verification is ready. Send at least 1 CYFUR to the displayed treasury address, then submit the transaction signature or explorer link. RelicGrid verifies finality before crediting."
                : "Deposits are temporarily unavailable. Please check back later. Do not send CYFUR until the status is READY.",
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
