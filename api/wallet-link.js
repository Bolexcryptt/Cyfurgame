const { randomBytes } = require("node:crypto");
const {
    authenticate,
    hasWalletEnvironment,
    serviceRequest,
    sendJson
} = require("./_lib/wallet");
const { isBase58 } = require("./_lib/solana-deposit");
const { verifyWalletSignature } = require("./_lib/solana-wallet-link");

module.exports = async function walletLink(request, response) {
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { error: "method_not_allowed" });
    }
    if (!hasWalletEnvironment() || !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
        return sendJson(response, 503, { error: "wallet_api_not_configured" });
    }

    try {
        const user = await authenticate(request);
        if (!user) return sendJson(response, 401, { error: "authentication_required" });

        const action = request.body?.action;
        if (action === "challenge") {
            const walletAddress = request.body?.walletAddress;
            if (!isBase58(walletAddress, 32)) {
                return sendJson(response, 400, { error: "invalid_wallet_address" });
            }
            const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
            const challenge = [
                "RelicGrid Solana wallet ownership proof",
                `Wallet: ${walletAddress}`,
                `Nonce: ${randomBytes(32).toString("hex")}`,
                `Expires: ${expiresAt.toISOString()}`
            ].join("\n");
            await serviceRequest("wallet_link_challenges?on_conflict=player_id", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Prefer: "resolution=merge-duplicates,return=minimal"
                },
                body: JSON.stringify({
                    player_id: user.id,
                    challenge,
                    expires_at: expiresAt.toISOString()
                })
            });
            return sendJson(response, 200, { challenge });
        }

        if (action !== "verify") {
            return sendJson(response, 400, { error: "invalid_wallet_link_action" });
        }
        const walletAddress = request.body?.walletAddress;
        const signature = request.body?.signature;
        if (!isBase58(walletAddress, 32) || typeof signature !== "string") {
            return sendJson(response, 400, { error: "invalid_wallet_proof" });
        }
        const challenges = await serviceRequest(
            `wallet_link_challenges?select=challenge,expires_at&player_id=eq.${encodeURIComponent(user.id)}&limit=1`
        );
        const challenge = challenges[0];
        if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now()) {
            return sendJson(response, 410, { error: "wallet_challenge_expired" });
        }
        if (!challenge.challenge.includes(`\nWallet: ${walletAddress}\n`)) {
            return sendJson(response, 422, { error: "wallet_challenge_mismatch" });
        }
        if (!verifyWalletSignature(walletAddress, challenge.challenge, signature)) {
            return sendJson(response, 422, { error: "wallet_signature_invalid" });
        }
        await serviceRequest("rpc/link_player_solana_wallet", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                p_player_id: user.id,
                p_wallet_address: walletAddress,
                p_challenge: challenge.challenge
            })
        });
        return sendJson(response, 200, { linked: true, walletAddress });
    } catch (error) {
        console.error("Solana wallet linking failed.", {
            status: error.status ?? 500,
            code: error.code ?? "wallet_link_failed"
        });
        if (error.status === 404 && error.code === "PGRST205") {
            return sendJson(response, 503, { error: "wallet_schema_not_installed" });
        }
        if (error.status === 404 && error.code === "PGRST202") {
            return sendJson(response, 503, { error: "wallet_migration_required" });
        }
        if (error.code === "23505") {
            return sendJson(response, 409, { error: "wallet_already_linked" });
        }
        return sendJson(response, 502, { error: "wallet_link_unavailable" });
    }
};
