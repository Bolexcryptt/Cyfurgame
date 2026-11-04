const {
    AccountLayout,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createTransferCheckedInstruction,
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID
} = require("@solana/spl-token");
const { Connection, Keypair, PublicKey, Transaction } = require("@solana/web3.js");
const {
    GENESIS_HASHES,
    getSolanaRpcUrl,
    isOfficialCyfurMintAccount,
    RELICGRID_CYFUR_MINT_ADDRESS,
    RELICGRID_TREASURY_ADDRESS
} = require("./solana-deposit");
const { getWithdrawalSignerFromEnvironment } = require("./withdrawals");

const CYFUR_TEST_RECIPIENT = "4bSjz5zdgReegh9TwCgiPWn7BH1nUhfY3s1DwZdK3UT1";
const CYFUR_TEST_AMOUNT_RAW = "100000000";
const CYFUR_TEST_DECIMALS = 8;
const TOKEN_PROGRAM_ADDRESS = TOKEN_PROGRAM_ID.toBase58();

function getTokenAccountInfo(account, expectedMint, expectedOwner, tokenProgram) {
    const parsed = account?.data?.parsed;
    const info = parsed?.info;
    if (!account?.owner?.equals?.(tokenProgram) ||
        parsed?.type !== "account" ||
        info?.mint !== expectedMint ||
        info?.owner !== expectedOwner ||
        typeof info?.tokenAmount?.amount !== "string" ||
        !/^\d+$/.test(info.tokenAmount.amount)) {
        return null;
    }
    return info;
}

async function readCyfurTreasuryTestPreflight({
    treasurySigner = getWithdrawalSignerFromEnvironment(),
    rpcUrl = getSolanaRpcUrl(),
    connectionFactory = (url, options) => new Connection(url, options),
    validateSigner = (signer) => signer instanceof Keypair
}) {
    if (process.env.SOLANA_NETWORK !== "mainnet-beta") {
        throw new Error("CYFUR test transfers require SOLANA_NETWORK=mainnet-beta.");
    }
    if (!validateSigner(treasurySigner) ||
        typeof treasurySigner?.publicKey?.toBase58 !== "function" ||
        treasurySigner.publicKey.toBase58() !== RELICGRID_TREASURY_ADDRESS) {
        throw new Error("The test-transfer signer does not match the fixed treasury.");
    }

    const connection = connectionFactory(rpcUrl, {
        commitment: "finalized",
        confirmTransactionInitialTimeout: 60000
    });
    const [genesisHash, treasurySolLamports, currentAtaRentLamports] = await Promise.all([
        connection.getGenesisHash(),
        connection.getBalance(treasurySigner.publicKey, "finalized"),
        connection.getMinimumBalanceForRentExemption(AccountLayout.span, "finalized")
    ]);
    if (genesisHash !== GENESIS_HASHES["mainnet-beta"]) {
        throw new Error("The configured Solana RPC endpoint is not mainnet-beta.");
    }

    const mint = new PublicKey(RELICGRID_CYFUR_MINT_ADDRESS);
    const recipient = new PublicKey(CYFUR_TEST_RECIPIENT);
    const tokenProgram = TOKEN_PROGRAM_ID;
    const treasuryTokenAccount = await getAssociatedTokenAddress(
        mint,
        treasurySigner.publicKey,
        false,
        tokenProgram
    );
    const recipientTokenAccount = await getAssociatedTokenAddress(
        mint,
        recipient,
        false,
        tokenProgram
    );
    const [mintAccount, treasuryTokenAccountInfo, recipientTokenAccountInfo] = await Promise.all([
        connection.getParsedAccountInfo(mint, "finalized"),
        connection.getParsedAccountInfo(treasuryTokenAccount, "finalized"),
        connection.getParsedAccountInfo(recipientTokenAccount, "finalized")
    ]);
    if (!isOfficialCyfurMintAccount({ value: mintAccount.value })) {
        throw new Error("The official CYFUR mint failed finalized on-chain verification.");
    }

    const treasuryTokenInfo = getTokenAccountInfo(
        treasuryTokenAccountInfo.value,
        mint.toBase58(),
        treasurySigner.publicKey.toBase58(),
        tokenProgram
    );
    if (!treasuryTokenInfo) {
        throw new Error("The finalized treasury CYFUR token account is missing or invalid.");
    }
    const treasuryCyfurAmountRaw = BigInt(treasuryTokenInfo.tokenAmount.amount);

    const recipientTokenInfo = recipientTokenAccountInfo.value
        ? getTokenAccountInfo(
            recipientTokenAccountInfo.value,
            mint.toBase58(),
            recipient.toBase58(),
            tokenProgram
        )
        : null;
    if (recipientTokenAccountInfo.value && !recipientTokenInfo) {
        throw new Error("The recipient associated token account failed finalized verification.");
    }
    const recipientCyfurAmountRaw = BigInt(recipientTokenInfo?.tokenAmount.amount ?? "0");

    const transaction = new Transaction();
    if (!recipientTokenAccountInfo.value) {
        transaction.add(createAssociatedTokenAccountInstruction(
            treasurySigner.publicKey,
            recipientTokenAccount,
            recipient,
            mint,
            tokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID
        ));
    }
    transaction.add(createTransferCheckedInstruction(
        treasuryTokenAccount,
        mint,
        recipientTokenAccount,
        treasurySigner.publicKey,
        BigInt(CYFUR_TEST_AMOUNT_RAW),
        CYFUR_TEST_DECIMALS,
        [],
        tokenProgram
    ));
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    transaction.feePayer = treasurySigner.publicKey;
    transaction.recentBlockhash = blockhash;
    const feeLamports = await connection.getFeeForMessage(transaction.compileMessage(), "finalized");
    const estimatedFeeLamports = feeLamports.value;
    const requiredSolLamports = estimatedFeeLamports === null
        ? null
        : estimatedFeeLamports +
            (recipientTokenAccountInfo.value ? 0 : currentAtaRentLamports);

    return {
        network: "mainnet-beta",
        genesisHash,
        treasuryAddress: RELICGRID_TREASURY_ADDRESS,
        treasurySolLamports,
        treasuryCyfurAmountRaw: treasuryCyfurAmountRaw.toString(),
        treasuryTokenAccount: treasuryTokenAccount.toBase58(),
        mintAddress: RELICGRID_CYFUR_MINT_ADDRESS,
        tokenProgramAddress: TOKEN_PROGRAM_ADDRESS,
        tokenDecimals: CYFUR_TEST_DECIMALS,
        recipient: CYFUR_TEST_RECIPIENT,
        recipientTokenAccount: recipientTokenAccount.toBase58(),
        recipientTokenAccountExists: Boolean(recipientTokenAccountInfo.value),
        recipientCyfurAmountRaw: recipientCyfurAmountRaw.toString(),
        currentAtaRentLamports,
        estimatedFeeLamports,
        requiredSolLamports,
        enoughCyfur: treasuryCyfurAmountRaw >= BigInt(CYFUR_TEST_AMOUNT_RAW),
        enoughSol: requiredSolLamports !== null && treasurySolLamports >= requiredSolLamports,
        amountRaw: CYFUR_TEST_AMOUNT_RAW
    };
}

async function executeCyfurTreasuryTestTransfer({
    treasurySigner = getWithdrawalSignerFromEnvironment(),
    rpcUrl = getSolanaRpcUrl(),
    connectionFactory = (url, options) => new Connection(url, options),
    transactionFactory = () => new Transaction(),
    validateSigner = (signer) => signer instanceof Keypair,
    onPrepared,
    onSigned
}) {
    if (process.env.SOLANA_NETWORK !== "mainnet-beta") {
        throw new Error("CYFUR test transfers require SOLANA_NETWORK=mainnet-beta.");
    }
    if (!validateSigner(treasurySigner) ||
        typeof treasurySigner?.publicKey?.toBase58 !== "function" ||
        treasurySigner.publicKey.toBase58() !== RELICGRID_TREASURY_ADDRESS) {
        throw new Error("The test-transfer signer does not match the fixed treasury.");
    }

    const connection = connectionFactory(rpcUrl, {
        commitment: "finalized",
        confirmTransactionInitialTimeout: 60000
    });
    const [genesisHash, treasurySolLamports] = await Promise.all([
        connection.getGenesisHash(),
        connection.getBalance(treasurySigner.publicKey, "finalized")
    ]);
    if (genesisHash !== GENESIS_HASHES["mainnet-beta"]) {
        throw new Error("The configured Solana RPC endpoint is not mainnet-beta.");
    }

    const mint = new PublicKey(RELICGRID_CYFUR_MINT_ADDRESS);
    const recipient = new PublicKey(CYFUR_TEST_RECIPIENT);
    const tokenProgram = TOKEN_PROGRAM_ID;
    const treasuryTokenAccount = await getAssociatedTokenAddress(
        mint,
        treasurySigner.publicKey,
        false,
        tokenProgram
    );
    const recipientTokenAccount = await getAssociatedTokenAddress(
        mint,
        recipient,
        false,
        tokenProgram
    );
    const [mintAccount, treasuryTokenAccountInfo, recipientTokenAccountInfo] = await Promise.all([
        connection.getParsedAccountInfo(mint, "finalized"),
        connection.getParsedAccountInfo(treasuryTokenAccount, "finalized"),
        connection.getParsedAccountInfo(recipientTokenAccount, "finalized")
    ]);
    if (!isOfficialCyfurMintAccount({ value: mintAccount.value })) {
        throw new Error("The official CYFUR mint failed finalized on-chain verification.");
    }

    const treasuryTokenInfo = getTokenAccountInfo(
        treasuryTokenAccountInfo.value,
        mint.toBase58(),
        treasurySigner.publicKey.toBase58(),
        tokenProgram
    );
    if (!treasuryTokenInfo ||
        BigInt(treasuryTokenInfo.tokenAmount.amount) < BigInt(CYFUR_TEST_AMOUNT_RAW)) {
        throw new Error("The finalized treasury CYFUR token account is missing, invalid, or underfunded.");
    }

    const recipientTokenInfo = recipientTokenAccountInfo.value
        ? getTokenAccountInfo(
            recipientTokenAccountInfo.value,
            mint.toBase58(),
            recipient.toBase58(),
            tokenProgram
        )
        : null;
    if (recipientTokenAccountInfo.value && !recipientTokenInfo) {
        throw new Error("The recipient associated token account failed finalized verification.");
    }
    const initialRecipientAmount = BigInt(recipientTokenInfo?.tokenAmount.amount ?? "0");

    const transaction = transactionFactory();
    let requiredRentLamports = 0;
    if (!recipientTokenAccountInfo.value) {
        requiredRentLamports = await connection.getMinimumBalanceForRentExemption(
            AccountLayout.span,
            "finalized"
        );
        transaction.add(createAssociatedTokenAccountInstruction(
            treasurySigner.publicKey,
            recipientTokenAccount,
            recipient,
            mint,
            tokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID
        ));
    }
    transaction.add(createTransferCheckedInstruction(
        treasuryTokenAccount,
        mint,
        recipientTokenAccount,
        treasurySigner.publicKey,
        BigInt(CYFUR_TEST_AMOUNT_RAW),
        CYFUR_TEST_DECIMALS,
        [],
        tokenProgram
    ));

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    transaction.feePayer = treasurySigner.publicKey;
    transaction.recentBlockhash = blockhash;
    const feeLamports = await connection.getFeeForMessage(transaction.compileMessage(), "finalized");
    if (feeLamports.value === null ||
        treasurySolLamports < requiredRentLamports + feeLamports.value) {
        throw new Error("The treasury SOL balance is insufficient for the current ATA rent and transaction fee.");
    }

    const preflight = {
        network: "mainnet-beta",
        treasurySolLamports,
        treasuryCyfurAmountRaw: treasuryTokenInfo.tokenAmount.amount,
        recipient: CYFUR_TEST_RECIPIENT,
        recipientTokenAccount: recipientTokenAccount.toBase58(),
        recipientTokenAccountExists: Boolean(recipientTokenAccountInfo.value),
        recipientCyfurAmountRaw: initialRecipientAmount.toString(),
        requiredRentLamports,
        feeLamports: feeLamports.value,
        amountRaw: CYFUR_TEST_AMOUNT_RAW
    };
    if (typeof onPrepared === "function") await onPrepared(preflight);

    await transaction.sign(treasurySigner);
    if (!transaction.signature) throw new Error("The treasury did not sign the test-transfer transaction.");
    const signature = require("./withdrawals").encodeBase58(transaction.signature);
    if (typeof onSigned === "function") await onSigned(signature, preflight);

    try {
        const broadcastSignature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            maxRetries: 3
        });
        if (broadcastSignature !== signature) {
            const error = new Error("The Solana RPC returned a signature that did not match the signed transaction.");
            error.submitted = true;
            error.signature = signature;
            throw error;
        }
        const confirmation = await connection.confirmTransaction({
            blockhash,
            lastValidBlockHeight,
            signature
        }, "finalized");
        if (confirmation.value.err) {
            const error = new Error("The submitted CYFUR test transfer failed on Solana.");
            error.chainFailed = true;
            throw error;
        }
    } catch (error) {
        error.signature = signature;
        error.submitted = true;
        throw error;
    }

    const finalizedRecipientAccount = await connection.getParsedAccountInfo(
        recipientTokenAccount,
        "finalized"
    );
    const finalizedRecipientInfo = getTokenAccountInfo(
        finalizedRecipientAccount.value,
        mint.toBase58(),
        recipient.toBase58(),
        tokenProgram
    );
    const finalAmount = BigInt(finalizedRecipientInfo?.tokenAmount.amount ?? "-1");
    if (finalAmount !== initialRecipientAmount + BigInt(CYFUR_TEST_AMOUNT_RAW)) {
        const error = new Error("The finalized recipient token balance did not increase by exactly 1 CYFUR.");
        error.signature = signature;
        error.submitted = true;
        error.finalized = true;
        throw error;
    }

    return {
        signature,
        status: "confirmed",
        amountRaw: CYFUR_TEST_AMOUNT_RAW,
        recipient: CYFUR_TEST_RECIPIENT,
        recipientTokenAccount: recipientTokenAccount.toBase58(),
        recipientCyfurAmountRaw: finalAmount.toString(),
        preflight
    };
}

module.exports = {
    CYFUR_TEST_AMOUNT_RAW,
    CYFUR_TEST_DECIMALS,
    CYFUR_TEST_RECIPIENT,
    TOKEN_PROGRAM_ADDRESS,
    readCyfurTreasuryTestPreflight,
    executeCyfurTreasuryTestTransfer
};
