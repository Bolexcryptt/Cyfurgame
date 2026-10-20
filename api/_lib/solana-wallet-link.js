const { createPublicKey, verify } = require("node:crypto");
const { isBase58 } = require("./solana-deposit");

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyWalletSignature(walletAddress, message, signatureBase64) {
    if (!isBase58(walletAddress, 32) || typeof message !== "string" ||
        typeof signatureBase64 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64)) {
        return false;
    }
    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== signatureBase64) return false;
    const publicKey = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, decodeBase58(walletAddress)]),
        format: "der",
        type: "spki"
    });
    return verify(null, Buffer.from(message, "utf8"), publicKey, signature);
}

function decodeBase58(value) {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let number = 0n;
    for (const character of value) {
        const digit = alphabet.indexOf(character);
        if (digit < 0) throw new TypeError("Invalid Base58 address.");
        number = number * 58n + BigInt(digit);
    }
    const bytes = [];
    while (number > 0n) {
        bytes.unshift(Number(number & 255n));
        number >>= 8n;
    }
    for (const character of value) {
        if (character !== "1") break;
        bytes.unshift(0);
    }
    return Buffer.from(bytes);
}

module.exports = { verifyWalletSignature };
