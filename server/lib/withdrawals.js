const { Connection, Keypair, PublicKey, Transaction } = require("@solana/web3.js");
const {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createTransferCheckedInstruction,
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID
} = require("@solana/spl-token");
const { CYFUR_CREDITS_PER_TOKEN } = require("./wallet");
const { isBase58, RELICGRID_CYFUR_MINT_ADDRESS, RELICGRID_TREASURY_ADDRESS } = require("./solana-deposit");

function getWithdrawalSignerFromEnvironment() {
    const secretValue = process.env.WITHDRAWAL_TREASURY_PRIVATE_KEY?.trim() || process.env.TREASURY_PRIVATE_KEY?.trim();
    if (!secretValue) {
        throw new Error("WITHDRAWAL_TREASURY_PRIVATE_KEY is not configured. Add the server-side treasury signer before enabling withdrawals.");
    }

    let keyBytes;
    try {
        const decoded = Buffer.from(secretValue, "base64");
        if (decoded.length === 64) {
            keyBytes = decoded;
        }
    } catch {
        // Allow JSON-array or base58 input to be rejected intentionally; the deployment must provide a real 64-byte secret.
    }
    if (!keyBytes) {
        try {
            const parsed = JSON.parse(secretValue);
            if (Array.isArray(parsed) && parsed.length === 64 && parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
                keyBytes = Buffer.from(parsed);
            }
        } catch {
            // Ignore; the deployment must set a real secret.
        }
    }
    if (!keyBytes || keyBytes.length !== 64) {
        throw new Error("The treasury withdrawal secret is invalid. It must be a 64-byte private key in base64 or JSON-array format.");
    }

    return Keypair.fromSecretKey(keyBytes);
}

function parseAmountToUnsignedBigInt(value, label) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        throw new TypeError(`${label} must be a decimal string with no sign.`);
    }
    return BigInt(value);
}

function calculateWithdrawalTokenAmountRaw(credits, tokenDecimals) {
    if (typeof credits !== "string" || !/^\d+$/.test(credits)) {
        throw new TypeError("Withdrawal credits must be a positive integer string.");
    }
    if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
        throw new TypeError("Token decimals must be an integer from 0 to 18.");
    }
    const creditsBigInt = BigInt(credits);
    if (creditsBigInt <= 0n) {
        throw new RangeError("Withdrawal credits must be greater than zero.");
    }
    const raw = (creditsBigInt * (10n ** BigInt(tokenDecimals))) / BigInt(CYFUR_CREDITS_PER_TOKEN);
    if (raw <= 0n) {
        throw new RangeError("This withdrawal amount converts to zero tokens and is not eligible.");
    }
    return raw.toString();
}

function calculateCreditsFromTokenAmountRaw(amountRaw, tokenDecimals) {
    const raw = parseAmountToUnsignedBigInt(amountRaw, "Token amount");
    if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
        throw new TypeError("Token decimals must be an integer from 0 to 18.");
    }
    if (raw <= 0n) {
        throw new RangeError("Token amount must be greater than zero.");
    }
    const scaledAmount = raw * BigInt(CYFUR_CREDITS_PER_TOKEN);
    return (scaledAmount / (10n ** BigInt(tokenDecimals))).toString();
}

async function executeCyfurWithdrawal({
    rpcUrl,
    playerWalletAddress,
    treasuryAddress = RELICGRID_TREASURY_ADDRESS,
    mintAddress = RELICGRID_CYFUR_MINT_ADDRESS,
    tokenProgramId = TOKEN_PROGRAM_ID.toBase58(),
    tokenDecimals = 8,
    amountRaw,
    treasurySigner = getWithdrawalSignerFromEnvironment()
}) {
    if (!isBase58(playerWalletAddress, 32)) {
        throw new TypeError("Player wallet address must be a valid Solana public key.");
    }
    if (!isBase58(treasuryAddress, 32) || !isBase58(mintAddress, 32)) {
        throw new TypeError("Treasury and mint addresses must be valid Solana public keys.");
    }
    if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
        throw new TypeError("The configured CYFUR token decimals are invalid.");
    }
    const rawAmount = parseAmountToUnsignedBigInt(amountRaw, "Withdrawal token amount");
    if (rawAmount <= 0n) {
        throw new RangeError("The withdrawal amount must be greater than zero.");
    }

    const connection = new Connection(rpcUrl, {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: 60000
    });
    const treasuryPublicKey = new PublicKey(treasuryAddress);
    const playerPublicKey = new PublicKey(playerWalletAddress);
    const mintPublicKey = new PublicKey(mintAddress);
    const tokenProgramKey = new PublicKey(tokenProgramId);
    const treasuryTokenAccount = await getAssociatedTokenAddress(
        mintPublicKey,
        treasuryPublicKey,
        false,
        tokenProgramKey
    );
    const playerTokenAccount = await getAssociatedTokenAddress(
        mintPublicKey,
        playerPublicKey,
        false,
        tokenProgramKey
    );

    const existingReceiverAccount = await connection.getAccountInfo(playerTokenAccount);
    const transaction = new Transaction();
    if (!existingReceiverAccount) {
        transaction.add(
            createAssociatedTokenAccountInstruction(
                treasuryPublicKey,
                playerTokenAccount,
                playerPublicKey,
                mintPublicKey,
                tokenProgramKey,
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
        );
    }
    transaction.add(
        createTransferCheckedInstruction(
            treasuryTokenAccount,
            mintPublicKey,
            playerTokenAccount,
            treasuryPublicKey,
            rawAmount,
            tokenDecimals,
            [],
            tokenProgramKey
        )
    );

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    transaction.feePayer = treasuryPublicKey;
    transaction.recentBlockhash = blockhash;

    const signedTransaction = await transaction.sign(treasurySigner);
    const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3
    });
    await connection.confirmTransaction({
        blockhash,
        lastValidBlockHeight,
        signature
    });

    return {
        signature,
        status: "confirmed",
        amountRaw: rawAmount.toString(),
        playerWalletAddress,
        treasuryAddress,
        mintAddress
    };
}

module.exports = {
    calculateCreditsFromTokenAmountRaw,
    calculateWithdrawalTokenAmountRaw,
    executeCyfurWithdrawal,
    getWithdrawalSignerFromEnvironment
};
