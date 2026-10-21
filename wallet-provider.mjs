export function getPhantomProvider(walletWindow = window) {
    const provider = walletWindow.phantom?.solana ?? walletWindow.solana;
    return provider?.isPhantom ? provider : null;
}

export function isMobileBrowser(navigatorObject = navigator) {
    if (navigatorObject.userAgentData?.mobile === true) return true;
    return /Android|iPhone|iPad|iPod/i.test(navigatorObject.userAgent) ||
        (navigatorObject.platform === "MacIntel" && navigatorObject.maxTouchPoints > 1);
}

export function createPhantomBrowseUrl(pageUrl) {
    const target = new URL(pageUrl);
    if (target.protocol !== "https:" || target.username || target.password) {
        throw new Error("Phantom can only open a secure HTTPS FluxGrid page.");
    }
    return `https://phantom.com/ul/browse/${encodeURIComponent(target.toString())}?ref=${encodeURIComponent(target.origin)}`;
}
