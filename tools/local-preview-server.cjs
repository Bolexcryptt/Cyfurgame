const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { areLevelsGloballyLocked } = require("../server/lib/level-lock");

const root = path.resolve(__dirname, "..");
const apiRoot = path.join(root, "api");
const port = Number(process.env.PORT || 3000);
const host = "127.0.0.1";
const maxBodyBytes = 1024 * 1024;
const publicFiles = new Set([
    "app.js",
    "assets/pbr/rock-color.jpg",
    "assets/pbr/rock-normal.jpg",
    "assets/pbr/rock-roughness.jpg",
    "assets/pbr/stone-color.jpg",
    "assets/pbr/stone-normal.jpg",
    "assets/pbr/stone-roughness.jpg",
    "background.png",
    "gamevideo.mp4",
    "index.html",
    "intro.mp4",
    "levels.js",
    "levels1.mp4",
    "levels2.mp4",
    "logo.png",
    "mirror.mp3",
    "music.mp3",
    "powersource.mp3",
    "script.js",
    "style.css",
    "supabase-config.js",
    "supabase.js",
    "theend.mp4",
    "vendor/tweetnacl.min.js",
    "wallet-provider.mjs"
]);
const contentTypes = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".ico", "image/x-icon"],
    [".jpeg", "image/jpeg"],
    [".jpg", "image/jpeg"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".mp3", "audio/mpeg"],
    [".mp4", "video/mp4"],
    [".mjs", "text/javascript; charset=utf-8"],
    [".png", "image/png"],
    [".svg", "image/svg+xml"],
    [".webm", "video/webm"],
    [".webp", "image/webp"]
]);

function sendJson(response, status, payload) {
    response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff"
    });
    response.end(JSON.stringify(payload));
}

function parseCookies(header = "") {
    return Object.fromEntries(header.split(";").flatMap((part) => {
        const separator = part.indexOf("=");
        if (separator < 0) return [];
        return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
    }));
}

async function prepareApiRequest(request, url) {
    request.query = Object.fromEntries(url.searchParams);
    request.cookies = parseCookies(request.headers.cookie);
    request.headers["x-forwarded-proto"] = "http";
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBodyBytes) {
            const error = new Error("Request body exceeds the local preview limit.");
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }

    if (chunks.length === 0) {
        request.body = undefined;
        return;
    }

    const body = Buffer.concat(chunks).toString("utf8");
    const contentType = request.headers["content-type"]?.split(";")[0].trim();
    if (contentType === "application/json") {
        try {
            request.body = JSON.parse(body);
        } catch {
            const error = new Error("Request body must contain valid JSON.");
            error.statusCode = 400;
            throw error;
        }
    } else if (contentType === "application/x-www-form-urlencoded") {
        request.body = Object.fromEntries(new URLSearchParams(body));
    } else {
        request.body = body;
    }
}

async function handleApiRequest(request, response, url) {
    const endpoint = decodeURIComponent(url.pathname.slice("/api/".length));
    if (!/^[a-z0-9-]+$/i.test(endpoint)) {
        sendJson(response, 404, { error: "not_found" });
        return;
    }

    const handlerPath = path.join(apiRoot, `${endpoint}.js`);
    if (!fs.existsSync(handlerPath)) {
        sendJson(response, 404, { error: "not_found" });
        return;
    }

    response.status = (status) => {
        response.statusCode = status;
        return response;
    };
    response.json = (payload) => {
        if (!response.headersSent) {
            response.setHeader("Content-Type", "application/json; charset=utf-8");
        }
        response.end(JSON.stringify(payload));
        return response;
    };
    response.send = (payload) => {
        response.end(payload);
        return response;
    };

    try {
        await prepareApiRequest(request, url);
        const handler = require(handlerPath);
        await handler(request, response);
        if (!response.writableEnded) response.end();
    } catch (error) {
        if (response.writableEnded) return;
        const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
        sendJson(response, status, { error: status === 500 ? "local_api_error" : "invalid_request" });
    }
}

function resolveStaticPath(pathname) {
    const decodedPath = decodeURIComponent(pathname);
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
    if (!publicFiles.has(relativePath) ||
        relativePath.split(/[\\/]/).some((segment) => segment.startsWith("."))) {
        return null;
    }
    const filePath = path.resolve(root, relativePath);
    if (!filePath.startsWith(`${root}${path.sep}`)) return null;
    return filePath;
}

function handleStaticRequest(request, response, url) {
    let filePath;
    try {
        filePath = resolveStaticPath(url.pathname);
    } catch {
        sendJson(response, 400, { error: "invalid_path" });
        return;
    }
    if (!filePath) {
        sendJson(response, 404, { error: "not_found" });
        return;
    }

    let stat;
    try {
        stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            filePath = path.join(filePath, "index.html");
            stat = fs.statSync(filePath);
        }
        if (!stat.isFile()) throw new Error("Not a file.");
    } catch {
        sendJson(response, 404, { error: "not_found" });
        return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
        "Content-Type": contentTypes.get(extension) || "application/octet-stream",
        "X-Content-Type-Options": "nosniff"
    };
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const range = request.headers.range;
    if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!match || (!match[1] && !match[2])) {
            response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
            response.end();
            return;
        }
        if (!match[1]) {
            const suffixLength = Number(match[2]);
            start = Math.max(0, stat.size - suffixLength);
        } else {
            start = Number(match[1]);
            if (match[2]) end = Number(match[2]);
        }
        if (start > end || start >= stat.size) {
            response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
            response.end();
            return;
        }
        end = Math.min(end, stat.size - 1);
        status = 206;
        headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    }

    headers["Content-Length"] = end - start + 1;
    response.writeHead(status, headers);
    if (request.method === "HEAD") {
        response.end();
        return;
    }
    fs.createReadStream(filePath, { start, end }).pipe(response);
}

const server = http.createServer((request, response) => {
    let url;
    try {
        url = new URL(request.url, `http://${request.headers.host}`);
    } catch {
        sendJson(response, 400, { error: "invalid_url" });
        return;
    }

    if (request.method !== "GET" && request.method !== "HEAD" &&
        !url.pathname.startsWith("/api/")) {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end();
        return;
    }

    if (url.pathname.startsWith("/api/")) {
        void handleApiRequest(request, response, url);
    } else {
        handleStaticRequest(request, response, url);
    }
});

server.listen(port, host, () => {
    console.log(`RelicGrid local preview: http://${host}:${port}`);
    console.log(`Global level lock: ${areLevelsGloballyLocked() ? "on" : "off (local process only)"}`);
});
