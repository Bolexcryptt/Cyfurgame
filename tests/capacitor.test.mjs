import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { handleApiCors } = require("../server/lib/wallet.js");

function createResponse() {
    return {
        headers: {},
        statusCode: 200,
        setHeader(name, value) {
            this.headers[name] = value;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
        }
    };
}

test("Capacitor Android and iOS origins are allowed to call the existing API", () => {
    const originalFrontendOrigin = process.env.GAME_FRONTEND_ORIGIN;
    delete process.env.GAME_FRONTEND_ORIGIN;
    try {
        for (const origin of ["https://localhost", "capacitor://localhost"]) {
            const response = createResponse();
            const handled = handleApiCors({
                method: "OPTIONS",
                headers: { origin }
            }, response);
            assert.equal(handled, true);
            assert.equal(response.statusCode, 204);
            assert.equal(response.headers["Access-Control-Allow-Origin"], origin);
        }
    } finally {
        if (originalFrontendOrigin === undefined) delete process.env.GAME_FRONTEND_ORIGIN;
        else process.env.GAME_FRONTEND_ORIGIN = originalFrontendOrigin;
    }
});

test("Capacitor CORS does not allow arbitrary origins", () => {
    const originalFrontendOrigin = process.env.GAME_FRONTEND_ORIGIN;
    delete process.env.GAME_FRONTEND_ORIGIN;
    try {
        const response = createResponse();
        const handled = handleApiCors({
            method: "OPTIONS",
            headers: { origin: "https://untrusted.example" }
        }, response);
        assert.equal(handled, true);
        assert.equal(response.statusCode, 403);
        assert.equal(response.body.error, "origin_not_allowed");
    } finally {
        if (originalFrontendOrigin === undefined) delete process.env.GAME_FRONTEND_ORIGIN;
        else process.env.GAME_FRONTEND_ORIGIN = originalFrontendOrigin;
    }
});
