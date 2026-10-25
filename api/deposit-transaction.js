const {
    authenticate,
    handleApiCors,
    hasWalletEnvironment,
    serviceRequest,
    sendJson
} = require("../server/lib/wallet");
const {
    GENESIS_HASHES,
    TOKEN_PROGRAM_IDS,
    isBase58,
    sanitizeRpcErrorData,
    sanitizeRpcErrorMessage,
    solanaRpc
} = require("../server/lib/solana-deposit");

function notReady(response, error, message) {
    return sendJson(response, 503, { error, message });
}

function getTokenAccountAddresses(result) {
    if (!Array.isArray(result?.value)) {
        throw new Error("The configured Solana RPC returned an invalid token-account response.");
    }
    return result.value.map((account) => {
        if (!isBase58(account?.pubkey, 32)) {
            throw new Error("The configured Solana RPC returned an invalid token-account address.");
        }
        return account.pubkey;
    });
}

function decodeSignedTransaction(value) {
    if (typeof value !== "string" || value.length > 1644 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        return null;
    }
    const transaction = Buffer.from(value, "base64");
    if (transaction.length === 0 || transaction.length > 1232 ||
        transaction.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
        return null;
    }
    return transaction;
}

function readShortVec(bytes, offset) {
    let value = 0;
    let shift = 0;
    let cursor = offset;
    while (cursor < bytes.length && shift <= 14) {
        const byte = bytes[cursor];
        value |= (byte & 0x7f) << shift;
        cursor += 1;
        if ((byte & 0x80) === 0) return { value, offset: cursor };
        shift += 7;
    }
    return null;
}

function encodeBase58(bytes) {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let value = 0n;
    for (const byte of bytes) value = value * 256n + BigInt(byte);
    let encoded = "";
    while (value > 0n) {
        encoded = alphabet[Number(value % 58n)] + encoded;
        value /= 58n;
    }
    for (const byte of bytes) {
        if (byte !== 0) break;
        encoded = `1${encoded}`;
    }
    return encoded || "1";
}

function inspectLegacyTransaction(transaction) {
    const signatureCount = readShortVec(transaction, 0);
    if (!signatureCount) return null;
    const messageOffset = signatureCount.offset + signatureCount.value * 64;
    if (messageOffset >= transaction.length) return null;
    const message = transaction.subarray(messageOffset);
    if (message[0] & 0x80) return null;

    let offset = 3;
    const keyCount = readShortVec(message, offset);
    if (!keyCount) return null;
    const requiredSignatureCount = message[0];
    offset = keyCount.offset;
    const accountKeys = [];
    for (let index = 0; index < keyCount.value; index += 1) {
        if (offset + 32 > message.length) return null;
        accountKeys.push(message.subarray(offset, offset + 32));
        offset += 32;
    }
    if (offset + 32 > message.length) return null;
    offset += 32;

    const instructionCount = readShortVec(message, offset);
    if (!instructionCount) return null;
    offset = instructionCount.offset;
    const instructionRoles = [];
    let associatedTokenAccountCreateCount = 0;
    let sourceTokenAccount;
    let treasuryTokenAccount;
    const instructions = [];

    for (let index = 0; index < instructionCount.value; index += 1) {
        if (offset >= message.length) return null;
        const programIndex = message[offset];
        offset += 1;
        const accountIndexCount = readShortVec(message, offset);
        if (!accountIndexCount) return null;
        offset = accountIndexCount.offset;
        const accountIndexes = message.subarray(offset, offset + accountIndexCount.value);
        if (accountIndexes.length !== accountIndexCount.value ||
            [...accountIndexes].some((accountIndex) => accountIndex >= accountKeys.length)) return null;
        offset += accountIndexCount.value;
        const dataLength = readShortVec(message, offset);
        if (!dataLength) return null;
        offset = dataLength.offset;
        const data = message.subarray(offset, offset + dataLength.value);
        if (data.length !== dataLength.value || programIndex >= accountKeys.length) return null;
        offset += dataLength.value;

        const programId = encodeBase58(accountKeys[programIndex]);
        if (programId === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" &&
            data.length === 1 &&
            (data[0] === 0 || data[0] === 1)) {
            instructionRoles.push("associated_token_account_create");
            associatedTokenAccountCreateCount += 1;
            instructions.push({
                type: "associated_token_account_create",
                payer: accountIndexes.length === 6 ? encodeBase58(accountKeys[accountIndexes[0]]) : null,
                account: accountIndexes.length === 6 ? encodeBase58(accountKeys[accountIndexes[1]]) : null,
                owner: accountIndexes.length === 6 ? encodeBase58(accountKeys[accountIndexes[2]]) : null,
                mint: accountIndexes.length === 6 ? encodeBase58(accountKeys[accountIndexes[3]]) : null,
                tokenProgramId: accountIndexes.length === 6 ? encodeBase58(accountKeys[accountIndexes[5]]) : null
            });
        } else if (TOKEN_PROGRAM_IDS.has(programId) &&
            data[0] === 12 && data.length === 10) {
            instructionRoles.push("spl_token_transfer_checked");
            if (accountIndexes.length >= 3) {
                sourceTokenAccount = encodeBase58(accountKeys[accountIndexes[0]]);
                treasuryTokenAccount = encodeBase58(accountKeys[accountIndexes[2]]);
            }
            instructions.push({
                type: "spl_token_transfer_checked",
                programId,
                source: accountIndexes.length === 4 ? encodeBase58(accountKeys[accountIndexes[0]]) : null,
                mint: accountIndexes.length === 4 ? encodeBase58(accountKeys[accountIndexes[1]]) : null,
                destination: accountIndexes.length === 4 ? encodeBase58(accountKeys[accountIndexes[2]]) : null,
                authority: accountIndexes.length === 4 ? encodeBase58(accountKeys[accountIndexes[3]]) : null,
                amountRaw: data.length === 10
                    ? data.subarray(1, 9).reduceRight((amount, byte) => amount * 256n + BigInt(byte), 0n).toString()
                    : null,
                decimals: data.length === 10 ? data[9] : null
            });
        } else if (programId === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr") {
            instructionRoles.push("memo");
            instructions.push({
                type: "memo",
                signers: [...accountIndexes].map((accountIndex) => encodeBase58(accountKeys[accountIndex]))
            });
        } else {
            instructionRoles.push("other");
            instructions.push({ type: "other" });
        }
    }
    if (offset !== message.length) return null;

    return {
        message,
        signatureCount: signatureCount.value,
        requiredSignatureCount,
        signaturesAreZero: transaction
            .subarray(signatureCount.offset, messageOffset)
            .every((byte) => byte === 0),
        payer: accountKeys.length ? encodeBase58(accountKeys[0]) : null,
        instructionRoles,
        associatedTokenAccountCreateCount,
        sourceTokenAccount,
        treasuryTokenAccount,
        instructions
    };
}

function validateUnsignedDiagnosticTransaction({
    transaction,
    payer,
    mint,
    tokenProgramId,
    treasury,
    amountRaw,
    tokenDecimals
}) {
    const inspected = inspectLegacyTransaction(transaction);
    if (!inspected ||
        inspected.signatureCount !== 1 ||
        inspected.requiredSignatureCount !== 1 ||
        !inspected.signaturesAreZero ||
        inspected.payer !== payer) {
        return null;
    }
    const transfers = inspected.instructions.filter((item) =>
        item.type === "spl_token_transfer_checked"
    );
    const creates = inspected.instructions.filter((item) =>
        item.type === "associated_token_account_create"
    );
    const memos = inspected.instructions.filter((item) => item.type === "memo");
    if (inspected.instructions.some((item) => item.type === "other") ||
        transfers.length !== 1 ||
        memos.length !== 1 ||
        creates.length > 2) {
        return null;
    }
    const transfer = transfers[0];
    if (transfer.programId !== tokenProgramId ||
        transfer.source !== inspected.sourceTokenAccount ||
        transfer.destination !== inspected.treasuryTokenAccount ||
        transfer.mint !== mint ||
        transfer.authority !== payer ||
        transfer.amountRaw !== amountRaw ||
        transfer.decimals !== tokenDecimals ||
        memos[0].signers.length !== 1 ||
        memos[0].signers[0] !== payer) {
        return null;
    }
    const createdAccounts = new Set();
    for (const create of creates) {
        if (create.payer !== payer ||
            create.mint !== mint ||
            create.tokenProgramId !== tokenProgramId ||
            ![transfer.source, transfer.destination].includes(create.account) ||
            ![payer, treasury].includes(create.owner) ||
            createdAccounts.has(create.account)) {
            return null;
        }
        if ((create.account === transfer.source && create.owner !== payer) ||
            (create.account === transfer.destination && create.owner !== treasury)) {
            return null;
        }
        createdAccounts.add(create.account);
    }
    return inspected;
}

async function runReadOnlyFundingDiagnostic({
    transaction,
    payer,
    connectedWalletPublicKey,
    treasury,
    mint,
    tokenProgramId,
    tokenDecimals,
    amountRaw,
    rpcUrl,
    network
}) {
    const inspected = validateUnsignedDiagnosticTransaction({
        transaction,
        payer,
        treasury,
        mint,
        tokenProgramId,
        tokenDecimals,
        amountRaw
    });
    if (!inspected) {
        const error = new Error("The read-only diagnostic transaction did not match the linked wallet and configured CYFUR transfer.");
        error.status = 400;
        throw error;
    }
    if (!isBase58(connectedWalletPublicKey, 32) ||
        connectedWalletPublicKey !== payer ||
        connectedWalletPublicKey !== inspected.payer) {
        const error = new Error("The connected Phantom public key, linked wallet, and transaction fee payer must match.");
        error.status = 400;
        throw error;
    }
    const feePayer = inspected.payer;
    const genesisHash = await solanaRpc(rpcUrl, "getGenesisHash", []);
    if (genesisHash !== GENESIS_HASHES[network]) {
        const error = new Error("Configured Solana RPC is connected to a different network.");
        error.status = 503;
        throw error;
    }

    const accountRequests = [
        ["source", inspected.sourceTokenAccount],
        ["treasury", inspected.treasuryTokenAccount]
    ];
    const rentRequest = tokenProgramId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        ? solanaRpc(rpcUrl, "getMinimumBalanceForRentExemption", [
            165,
            { commitment: "confirmed" }
        ])
        : Promise.resolve(null);
    const requests = [
        solanaRpc(rpcUrl, "getBalance", [feePayer, { commitment: "confirmed" }]),
        rentRequest,
        solanaRpc(rpcUrl, "getFeeForMessage", [
            inspected.message.toString("base64"),
            { commitment: "confirmed" }
        ]),
        ...accountRequests.map(([, address]) => solanaRpc(rpcUrl, "getAccountInfo", [
            address,
            { commitment: "confirmed", encoding: "jsonParsed" }
        ])),
        solanaRpc(rpcUrl, "getAccountInfo", [
            feePayer,
            { commitment: "confirmed", encoding: "base64" }
        ]),
        solanaRpc(rpcUrl, "simulateTransaction", [
            transaction.toString("base64"),
            {
                encoding: "base64",
                commitment: "confirmed",
                sigVerify: false,
                replaceRecentBlockhash: true
            }
        ])
    ];
    const [
        balance,
        rent,
        fee,
        source,
        treasuryAccount,
        feePayerAccount,
        simulation
    ] = await Promise.all(requests);
    if (!source || !Object.prototype.hasOwnProperty.call(source, "value") ||
        !treasuryAccount || !Object.prototype.hasOwnProperty.call(treasuryAccount, "value") ||
        !feePayerAccount || !Object.prototype.hasOwnProperty.call(feePayerAccount, "value")) {
        throw new Error("The configured Solana RPC returned an invalid token-account response.");
    }
    const payerLamports = Number.isSafeInteger(balance?.value) && balance.value >= 0
        ? balance.value
        : null;
    const rentLamports = Number.isSafeInteger(rent) && rent >= 0 ? rent : null;
    const feeLamports = Number.isSafeInteger(fee?.value) && fee.value >= 0
        ? fee.value
        : null;
    const sourceExists = Boolean(source?.value);
    const treasuryExists = Boolean(treasuryAccount?.value);
    const createInstructions = new Set(inspected.instructions
        .filter((item) => item.type === "associated_token_account_create")
        .map((item) => item.account));
    const requiredRentLamports = rentLamports === null
        ? null
        : (sourceExists || !createInstructions.has(inspected.sourceTokenAccount) ? 0 : rentLamports) +
            (treasuryExists || !createInstructions.has(inspected.treasuryTokenAccount) ? 0 : rentLamports);
    const requiredTotalLamports = feeLamports === null || requiredRentLamports === null
        ? null
        : feeLamports + requiredRentLamports;
    const sourceInfo = source?.value?.data?.parsed?.info;
    const treasuryInfo = treasuryAccount?.value?.data?.parsed?.info;
    const amountText = String(sourceInfo?.tokenAmount?.amount ?? "");
    const sourceAmountRaw = amountText.length <= 20 && /^\d+$/.test(amountText)
        ? amountText
        : null;
    const sourceAmount = sourceAmountRaw === null ? null : BigInt(sourceAmountRaw);
    const expectedAmount = BigInt(amountRaw);
    const simulationError = simulation?.value?.err ?? null;
    if (!simulation?.value || typeof simulation.value !== "object") {
        throw new Error("The configured Solana RPC returned an invalid simulation response.");
    }
    const sanitizedSimulation = sanitizeRpcErrorData({
        logs: simulation.value.logs,
        unitsConsumed: simulation.value.unitsConsumed
    });
    const instructionFailure = Array.isArray(simulationError?.InstructionError) &&
        Number.isSafeInteger(simulationError.InstructionError[0])
        ? simulationError.InstructionError[0]
        : null;

    return {
        network,
        feePayerAccountExists: Boolean(feePayerAccount.value),
        feePayerOwnerProgram: feePayerAccount.value?.owner ?? null,
        feePayerSystemProgramOwned:
            feePayerAccount.value?.owner === "11111111111111111111111111111111",
        feePayerKeyMatchesConnectedPhantom: feePayer === connectedWalletPublicKey,
        feePayerKeyMatchesLinkedWallet: feePayer === payer,
        payerBalanceQueryMatchesFeePayer: true,
        payerLamports,
        transactionFeeLamports: feeLamports,
        tokenAccountRentLamports: rentLamports,
        requiredRentLamports,
        requiredTotalLamports,
        payerBalanceCoversFeeAndRent: payerLamports === null || requiredTotalLamports === null
            ? null
            : payerLamports >= requiredTotalLamports,
        sourceTokenAccountExists: sourceExists,
        sourceTokenAccountOwnerMatchesPayer: sourceInfo?.owner === payer,
        sourceTokenAccountMintMatchesConfiguredMint: sourceInfo?.mint === mint,
        sourceTokenAccountProgramMatchesConfig: source?.value?.owner === tokenProgramId,
        sourceTokenAmountRaw: sourceAmountRaw,
        sourceTokenAmountCoversTransfer: sourceAmount === null
            ? null
            : sourceAmount >= expectedAmount,
        treasuryTokenAccountExists: treasuryExists,
        treasuryTokenAccountOwnerMatchesTreasury: treasuryInfo?.owner === treasury,
        treasuryTokenAccountMintMatchesConfiguredMint: treasuryInfo?.mint === mint,
        treasuryTokenAccountProgramMatchesConfig: treasuryAccount?.value?.owner === tokenProgramId,
        instructionRoles: inspected.instructionRoles,
        failedInstructionIndex: instructionFailure,
        failedInstructionRole: instructionFailure === null
            ? null
            : inspected.instructionRoles[instructionFailure] ?? "unknown",
        simulationPassed: Object.prototype.hasOwnProperty.call(simulation.value, "err") &&
            simulationError === null,
        simulationError: simulationError === null
            ? null
            : sanitizeRpcErrorData({ err: simulationError })?.err ?? "Unknown simulation error",
        simulationLogs: sanitizedSimulation?.logs ?? [],
        simulationUnitsConsumed: sanitizedSimulation?.unitsConsumed ?? null
    };
}

async function logSimulationFundingDiagnostics({
    transaction,
    payer,
    treasuryOwner,
    mint,
    tokenProgramId,
    expectedAmountRaw,
    rpcUrl
}) {
    const inspected = inspectLegacyTransaction(transaction);
    const diagnosticRpc = async (method, params) => {
        try {
            return await solanaRpc(rpcUrl, method, params);
        } catch (error) {
            console.error("Solana funding diagnostic RPC failed.", {
                method,
                rpcCode: Number.isInteger(error.rpcCode) ? error.rpcCode : null,
                rpcMessage: sanitizeRpcErrorMessage(error.rpcMessage || error.message)
            });
            return null;
        }
    };
    const requests = [
        diagnosticRpc("getBalance", [payer, { commitment: "confirmed" }]),
        tokenProgramId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            ? diagnosticRpc("getMinimumBalanceForRentExemption", [165, { commitment: "confirmed" }])
            : Promise.resolve(null),
        diagnosticRpc("getFeeForMessage", [
            inspected?.message.toString("base64") ?? "",
            { commitment: "confirmed" }
        ]),
        inspected?.sourceTokenAccount
            ? diagnosticRpc("getAccountInfo", [
                inspected.sourceTokenAccount,
                { commitment: "confirmed", encoding: "jsonParsed" }
            ])
            : Promise.resolve(null),
        inspected?.treasuryTokenAccount
            ? diagnosticRpc("getAccountInfo", [
                inspected.treasuryTokenAccount,
                { commitment: "confirmed", encoding: "jsonParsed" }
            ])
            : Promise.resolve(null)
    ];
    const [balance, rent, fee, source, treasury] = await Promise.all(requests);
    const payerLamports = Number.isSafeInteger(balance?.value) && balance.value >= 0
        ? balance.value
        : null;
    const rentLamports = Number.isSafeInteger(rent) && rent >= 0 ? rent : null;
    const feeLamports = Number.isSafeInteger(fee?.value) && fee.value >= 0
        ? fee.value
        : null;
    const requiredRentLamports = rentLamports === null || !inspected
        ? null
        : rentLamports * inspected.associatedTokenAccountCreateCount;
    const requiredTotalLamports = feeLamports === null || requiredRentLamports === null
        ? null
        : feeLamports + requiredRentLamports;
    const sourceInfo = source?.value?.data?.parsed?.info;
    const treasuryInfo = treasury?.value?.data?.parsed?.info;
    const sourceAmountText = String(sourceInfo?.tokenAmount?.amount ?? "");
    const sourceAmount = sourceAmountText.length <= 20 && /^\d+$/.test(sourceAmountText)
        ? BigInt(sourceInfo.tokenAmount.amount)
        : null;
    let expectedAmount = null;
    try {
        if (/^[1-9]\d*$/.test(String(expectedAmountRaw))) {
            expectedAmount = BigInt(expectedAmountRaw);
        }
    } catch {
        expectedAmount = null;
    }

    console.info("Deposit transaction simulation funding diagnostics.", {
        instructionRoles: inspected?.instructionRoles ?? null,
        associatedTokenAccountCreateCount: inspected?.associatedTokenAccountCreateCount ?? null,
        payerLamports,
        transactionFeeLamports: feeLamports,
        tokenAccountRentLamports: rentLamports,
        requiredRentLamports,
        requiredTotalLamports,
        payerBalanceCoversFeeAndRent: payerLamports !== null &&
            requiredTotalLamports !== null &&
            payerLamports >= requiredTotalLamports,
        sourceTokenAccountExists: Boolean(source?.value),
        sourceTokenAccountOwnerMatchesPayer: sourceInfo?.owner === payer,
        sourceTokenAccountMintMatchesIntent: sourceInfo?.mint === mint,
        sourceTokenAccountProgramMatchesConfig: source?.value?.owner === tokenProgramId,
        sourceTokenAmountCoversIntent: sourceAmount !== null &&
            expectedAmount !== null &&
            sourceAmount >= expectedAmount,
        treasuryTokenAccountExists: Boolean(treasury?.value),
        treasuryTokenAccountOwnerMatchesTreasury: treasuryInfo?.owner === treasuryOwner,
        treasuryTokenAccountMintMatchesIntent: treasuryInfo?.mint === mint,
        treasuryTokenAccountProgramMatchesConfig: treasury?.value?.owner === tokenProgramId
    });
}

module.exports = async function depositTransaction(request, response) {
    let stage = "request_validation";
    if (handleApiCors(request, response)) return;
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (!hasWalletEnvironment()) {
        return sendJson(response, 503, { error: "wallet_api_not_configured" });
    }

    try {
        stage = "authentication";
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });
        const action = request.body?.action;
        const readOnlyAction = action === "diagnose" || action === "prepare-diagnostic";

        const missing = [
            "SUPABASE_SERVICE_ROLE_KEY",
            "SOLANA_RPC_URL",
            "SOLANA_TREASURY_ADDRESS"
        ].filter((name) => !process.env[name]?.trim());
        if (missing.length) {
            return notReady(
                response,
                "wallet_verifier_not_configured",
                `Deposit preparation is disabled. Configure server-only ${missing.join(", ")}.`
            );
        }
        if (!readOnlyAction && process.env.WALLET_DIRECT_TREASURY_READY !== "true") {
            return notReady(response, "direct_treasury_not_ready", "Direct treasury deposits are not approved.");
        }
        const network = process.env.SOLANA_NETWORK;
        if ((!readOnlyAction && process.env.WALLET_DEPOSITS_ENABLED !== "true") ||
            !["devnet", "mainnet-beta"].includes(network)) {
            return notReady(response, "deposits_disabled", "Deposit preparation is disabled by server configuration.");
        }
        if (!readOnlyAction && network === "mainnet-beta" &&
            process.env.WALLET_MAINNET_DEPOSITS_ENABLED !== "true") {
            return notReady(response, "mainnet_deposits_disabled", "Mainnet deposits are not enabled.");
        }

        stage = "database_configuration";
        const [configs, linkedWallets] = await Promise.all([
            serviceRequest("wallet_system_config?select=deposits_enabled,network,official_mint_address,token_program_id,token_decimals,credits_per_token,rounding_policy,treasury_address&id=eq.1"),
            serviceRequest(`player_solana_wallets?select=wallet_address&player_id=eq.${encodeURIComponent(user.id)}&limit=1`)
        ]);
        const config = configs[0];
        const linkedWallet = linkedWallets[0]?.wallet_address;
        if (!config || (!readOnlyAction && config.deposits_enabled !== true) ||
            config.network !== network ||
            !isBase58(config.official_mint_address, 32) ||
            !TOKEN_PROGRAM_IDS.has(config.token_program_id) ||
            !Number.isInteger(config.token_decimals) ||
            String(config.credits_per_token) !== "10000" ||
            config.rounding_policy !== "floor" ||
            !isBase58(config.treasury_address, 32) ||
            config.treasury_address !== process.env.SOLANA_TREASURY_ADDRESS) {
            return notReady(response, "wallet_configuration_incomplete", "Deposit configuration is not ready.");
        }
        if (!isBase58(linkedWallet, 32)) {
            return sendJson(response, 409, {
                error: "solana_wallet_not_linked",
                message: "Connect and verify the wallet linked to this game account."
            });
        }

        if (action === "diagnose") {
            stage = "diagnostic_payload_validation";
            const transaction = decodeSignedTransaction(request.body?.transaction);
            const amountRaw = request.body?.amountRaw;
            if (!transaction ||
                typeof amountRaw !== "string" ||
                !/^[1-9]\d*$/.test(amountRaw) ||
                amountRaw.length > 20 ||
                BigInt(amountRaw) > 18446744073709551615n) {
                return sendJson(response, 400, { error: "invalid_diagnostic_transaction" });
            }
            stage = "diagnostic_rpc";
            const diagnostic = await runReadOnlyFundingDiagnostic({
                transaction,
                payer: linkedWallet,
                connectedWalletPublicKey: request.body?.connectedWalletPublicKey,
                treasury: config.treasury_address,
                mint: config.official_mint_address,
                tokenProgramId: config.token_program_id,
                tokenDecimals: config.token_decimals,
                amountRaw,
                rpcUrl: process.env.SOLANA_RPC_URL,
                network
            });
            return sendJson(response, 200, diagnostic);
        }

        if (action === "prepare" || action === "prepare-diagnostic") {
            stage = "prepare_rpc";
            const [genesisHash, senderAccounts, treasuryAccounts] = await Promise.all([
                solanaRpc(process.env.SOLANA_RPC_URL, "getGenesisHash", []),
                solanaRpc(process.env.SOLANA_RPC_URL, "getTokenAccountsByOwner", [
                    linkedWallet,
                    { mint: config.official_mint_address },
                    { commitment: "confirmed", encoding: "jsonParsed" }
                ]),
                solanaRpc(process.env.SOLANA_RPC_URL, "getTokenAccountsByOwner", [
                    config.treasury_address,
                    { mint: config.official_mint_address },
                    { commitment: "confirmed", encoding: "jsonParsed" }
                ])
            ]);
            if (genesisHash !== GENESIS_HASHES[network]) {
                return notReady(response, "solana_rpc_network_mismatch", "Configured Solana RPC is connected to a different network.");
            }
            const latestBlockhash = await solanaRpc(process.env.SOLANA_RPC_URL, "getLatestBlockhash", [
                { commitment: "confirmed" }
            ]);
            const blockhash = latestBlockhash?.value?.blockhash;
            if (!isBase58(blockhash, 32) ||
                !Number.isSafeInteger(latestBlockhash?.value?.lastValidBlockHeight)) {
                throw new Error("The configured Solana RPC returned an invalid recent blockhash.");
            }
            return sendJson(response, 200, {
                blockhash,
                lastValidBlockHeight: latestBlockhash.value.lastValidBlockHeight,
                senderTokenAccounts: getTokenAccountAddresses(senderAccounts),
                treasuryTokenAccounts: getTokenAccountAddresses(treasuryAccounts)
            });
        }

        if (action === "broadcast") {
            stage = "broadcast_payload_validation";
            const paymentIntentId = request.body?.paymentIntentId;
            if (typeof paymentIntentId !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentIntentId)) {
                return sendJson(response, 400, { error: "payment_intent_required" });
            }
            const transaction = decodeSignedTransaction(request.body?.transaction);
            if (!transaction) {
                return sendJson(response, 400, { error: "invalid_signed_transaction" });
            }
            stage = "broadcast_payment_intent";
            const [intent] = await serviceRequest(
                `wallet_payment_intents?select=id,player_id,source_wallet_address,network,mint_address,token_program_id,treasury_address,amount_raw,token_decimals,expires_at,status&id=eq.${encodeURIComponent(paymentIntentId)}&player_id=eq.${encodeURIComponent(user.id)}&limit=1`
            );
            const intentExpiresAt = Date.parse(intent?.expires_at);
            const intentAmount = String(intent?.amount_raw ?? "");
            if (!intent ||
                intent.player_id !== user.id ||
                intent.source_wallet_address !== linkedWallet ||
                intent.network !== config.network ||
                intent.mint_address !== config.official_mint_address ||
                intent.token_program_id !== config.token_program_id ||
                intent.treasury_address !== config.treasury_address ||
                intent.token_decimals !== config.token_decimals ||
                !/^[1-9]\d*$/.test(intentAmount) ||
                intentAmount.length > 20 ||
                BigInt(intentAmount) > 18446744073709551615n ||
                !Number.isFinite(intentExpiresAt) ||
                intentExpiresAt <= Date.now() ||
                intent.status !== "pending") {
                return sendJson(response, 409, {
                    error: "payment_intent_invalid_or_expired",
                    message: "The payment intent is no longer valid. No transaction was submitted."
                });
            }
            stage = "broadcast_rpc_context";
            const [genesisHash, minContextSlot] = await Promise.all([
                solanaRpc(process.env.SOLANA_RPC_URL, "getGenesisHash", []),
                solanaRpc(process.env.SOLANA_RPC_URL, "getSlot", [
                    { commitment: "confirmed" }
                ])
            ]);
            if (genesisHash !== GENESIS_HASHES[network]) {
                return notReady(response, "solana_rpc_network_mismatch", "Configured Solana RPC is connected to a different network.");
            }
            if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0) {
                throw new Error("The configured Solana RPC returned an invalid current slot.");
            }
            stage = "broadcast_rpc_send";
            const signedTransactionBase64 = transaction.toString("base64");
            let signature;
            try {
                signature = await solanaRpc(process.env.SOLANA_RPC_URL, "sendTransaction", [
                    signedTransactionBase64,
                    {
                        encoding: "base64",
                        preflightCommitment: "confirmed",
                        minContextSlot
                    }
                ]);
            } catch (error) {
                if (error.rpcCode === -32002) {
                    try {
                        await logSimulationFundingDiagnostics({
                            transaction,
                            payer: linkedWallet,
                            treasuryOwner: config.treasury_address,
                            mint: config.official_mint_address,
                            tokenProgramId: config.token_program_id,
                            expectedAmountRaw: intentAmount,
                            rpcUrl: process.env.SOLANA_RPC_URL
                        });
                    } catch (diagnosticError) {
                        console.error("Deposit simulation diagnostics failed.", {
                            errorName: diagnosticError?.name || "Error",
                            errorMessage: sanitizeRpcErrorMessage(
                                diagnosticError?.message || "Unknown diagnostic error"
                            )
                        });
                    }
                }
                if (error.rpcCode !== -32016 ||
                    !/minimum context slot has not been reached/i.test(error.rpcMessage ?? "")) {
                    throw error;
                }
                console.warn("Solana RPC has not reached the requested broadcast context slot; retrying with preflight enabled.", {
                    stage,
                    rpcCode: error.rpcCode,
                    rpcMessage: sanitizeRpcErrorMessage(error.rpcMessage),
                    minContextSlot
                });
                stage = "broadcast_rpc_send_context_fallback";
                signature = await solanaRpc(process.env.SOLANA_RPC_URL, "sendTransaction", [
                    signedTransactionBase64,
                    {
                        encoding: "base64",
                        preflightCommitment: "confirmed"
                    }
                ]);
            }
            if (!isBase58(signature, 64)) {
                throw new Error("The configured Solana RPC returned an invalid transaction signature.");
            }
            return sendJson(response, 200, { signature });
        }

        return sendJson(response, 400, { error: "invalid_action" });
    } catch (error) {
        if (error.status === 400) {
            return sendJson(response, 400, {
                error: "invalid_diagnostic_transaction",
                message: error.message
            });
        }
        if (error.status === 503 && stage === "diagnostic_rpc") {
            return notReady(response, "solana_rpc_network_mismatch", error.message);
        }
        const blockhashExpired = error.rpcCode === -32002 &&
            /blockhash not found/i.test(error.rpcMessage ?? "");
        console.error("Deposit transaction request failed.", {
            stage,
            status: error.status ?? (blockhashExpired ? 409 : 502),
            errorName: error.name || "Error",
            errorMessage: blockhashExpired
                ? "Solana RPC sendTransaction failed: blockhash not found."
                : sanitizeRpcErrorMessage(error.message || "Unknown error"),
            rpcCode: Number.isInteger(error.rpcCode) ? error.rpcCode : null,
            rpcMessage: sanitizeRpcErrorMessage(error.rpcMessage),
            rpcData: sanitizeRpcErrorData(error.rpcData),
            rpcForbidden: error.message?.includes("(403)") === true
        });
        if (blockhashExpired) {
            return sendJson(response, 409, {
                error: "blockhash_expired",
                message: "The Solana RPC rejected this blockhash. Refresh the transaction and approve the new transaction in Phantom."
            });
        }
        const forbidden = error.message?.includes("(403)") === true;
        return sendJson(response, 502, {
            error: forbidden ? "solana_rpc_forbidden" : "solana_rpc_unavailable",
            message: forbidden
                ? "The configured server Solana RPC returned HTTP 403. Check the provider's API access and network permissions; no transaction was submitted."
                : "The configured server Solana RPC could not prepare or submit this transaction. No credits will be added unless the deposit verifier confirms it."
        });
    }
};
