import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("iOS project matches Capacitor 7 plugins and supports the game orientation flow", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const capacitorConfig = JSON.parse(readFileSync(new URL("../capacitor.config.json", import.meta.url), "utf8"));
    const podfile = readFileSync(new URL("../ios/App/Podfile", import.meta.url), "utf8");
    const project = readFileSync(new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url), "utf8");
    const infoPlist = readFileSync(new URL("../ios/App/App/Info.plist", import.meta.url), "utf8");
    const scheme = readFileSync(new URL("../ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme", import.meta.url), "utf8");

    assert.match(packageJson.dependencies["@capacitor/core"], /^\^7\./);
    for (const plugin of ["app", "browser", "screen-orientation", "status-bar"]) {
        assert.match(packageJson.dependencies[`@capacitor/${plugin}`], /^\^7\./);
    }
    assert.equal(capacitorConfig.appId, "com.relicgrid.cyfurgame");
    assert.equal(capacitorConfig.plugins.ScreenOrientation.orientation, "portrait");
    assert.match(podfile, /platform :ios, '14\.0'/);
    assert.match(podfile, /pod 'CapacitorScreenOrientation'/);
    assert.match(podfile, /pod 'CapacitorStatusBar'/);
    assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = com\.relicgrid\.cyfurgame/);
    assert.match(project, /MARKETING_VERSION = 1\.41/);
    assert.match(project, /CURRENT_PROJECT_VERSION = 42/);
    assert.match(infoPlist, /UIInterfaceOrientationLandscapeLeft/);
    assert.match(infoPlist, /UIInterfaceOrientationLandscapeRight/);
    assert.match(scheme, /BlueprintName="App"/);
});

test("iOS workflow defaults to unsigned archives and gates TestFlight signing behind manual dispatch", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ios.yml", import.meta.url), "utf8");

    assert.match(workflow, /runs-on: macos-15/);
    assert.match(workflow, /CODE_SIGNING_ALLOWED=NO/);
    assert.match(workflow, /relicgrid-ios-unsigned-ipa-sideloadly/);
    assert.match(workflow, /ditto "\$app" "\$payload\/App\.app"/);
    assert.match(workflow, /lipo -archs "\$executable"/);
    assert.match(workflow, /LC_ENCRYPTION_INFO/);
    assert.match(workflow, /codesign -dv "\$app"/);
    assert.match(workflow, /Print CFBundleIdentifier/);
    assert.match(workflow, /Base\.lproj\/LaunchScreen\.storyboardc/);
    assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.testflight_release/);
    assert.match(workflow, /apple-actions\/import-codesign-certs@v3/);
    assert.match(workflow, /fastlane pilot upload/);
    for (const secret of [
        "IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64",
        "IOS_DISTRIBUTION_CERTIFICATE_PASSWORD",
        "IOS_PROVISIONING_PROFILE_BASE64",
        "APPLE_TEAM_ID",
        "ASC_API_KEY_ID",
        "ASC_API_ISSUER_ID",
        "ASC_API_PRIVATE_KEY"
    ]) {
        assert.match(workflow, new RegExp(`secrets\\.${secret}`));
    }
    assert.doesNotMatch(workflow, /-----BEGIN (?:RSA )?PRIVATE KEY-----/);
});
