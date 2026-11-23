# iOS build and TestFlight deployment

RelicGrid uses Capacitor 7.6.10 with the matching iOS platform and iOS-compatible App, Browser, Screen Orientation, and Status Bar plugins. The iOS app keeps the existing `com.relicgrid.cyfurgame` bundle identifier, `relicgrid` URL scheme, portrait/landscape support, and the same web app and backend as Android. Its deployment target is iOS 14.0.

For a signed App Store distribution IPA, use the separate [App Store distribution workflow and setup guide](./ios-app-store-distribution.md). The personal Sideloadly workflow below remains unsigned and unchanged.

## Unsigned build

The `iOS build` GitHub Actions workflow runs on `macos-15` when code is pushed to `main`. It builds the web app, syncs Capacitor, installs CocoaPods, and creates an unsigned `.xcarchive`. Download the `relicgrid-ios-unsigned-xcarchive` artifact from the completed workflow run.

An unsigned archive is for build verification only. It cannot be installed on an iPhone or uploaded to TestFlight without Apple signing.

## Install on an iPhone with Sideloadly

The same macOS workflow also packages the unsigned archive as an arm64 `.ipa` and uploads the `relicgrid-ios-unsigned-ipa-sideloadly` artifact. The workflow validates the `Payload/App.app` structure, the existing bundle identifier, launch-screen and asset catalog resources, the arm64 executable, and that the executable is not FairPlay-encrypted.

This IPA is intentionally unsigned. Sideloadly must sign it locally with your Apple Account before installing it; a free Apple Account normally creates a short-lived personal provisioning profile (typically seven days). Re-sign or reinstall it when that profile expires. The project keeps `com.relicgrid.cyfurgame`; no bundle-ID change is made. If Apple reports that identifier is unavailable for your account, stop before changing it, because a different ID creates a separate app identity and may affect app callbacks.

1. Download `relicgrid-ios-unsigned-ipa-sideloadly` from the successful **iOS build** GitHub Actions run and extract the artifact ZIP to find `RelicGrid-unsigned.ipa`.
2. Connect the iPhone, unlock it, and trust the Dell when prompted.
3. Open Sideloadly, select the IPA, select the connected iPhone, enter your Apple Account in Sideloadly on the PC, and start sideloading. Never send the Apple password to anyone.
4. On the iPhone, enable **Settings → Privacy & Security → Developer Mode** if prompted and restart. Then trust the developer under **Settings → General → VPN & Device Management** if iOS asks.
5. Launch RelicGrid. Free-account signing is for personal testing and is not TestFlight/App Store distribution.

## Apple setup for TestFlight

You need:

1. An active Apple Developer Program membership and an App Store Connect user with permission to manage the app and TestFlight.
2. An App Store Connect app record using bundle ID `com.relicgrid.cyfurgame`.
3. An Apple Distribution certificate exported as a password-protected `.p12` file.
4. An App Store provisioning profile for `com.relicgrid.cyfurgame`, associated with the distribution certificate and your Apple Developer team.
5. An App Store Connect API key with permission to upload builds, plus its Key ID, Issuer ID, and downloaded `.p8` private key.
6. Your Apple Developer Team ID.

Create these **repository Actions secrets** under **Settings → Secrets and variables → Actions**. Do not put their values in the repository or chat.

| Secret | Value |
| --- | --- |
| `IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64` | Base64-encoded distribution `.p12` file |
| `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` |
| `IOS_PROVISIONING_PROFILE_BASE64` | Base64-encoded App Store `.mobileprovision` file |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `ASC_API_KEY_ID` | App Store Connect API Key ID |
| `ASC_API_ISSUER_ID` | App Store Connect Issuer ID |
| `ASC_API_PRIVATE_KEY` | Full contents of the downloaded `.p8` key, including PEM boundary lines |

Encode the certificate or profile locally on Windows, then paste the result directly into the matching GitHub secret (never into source files):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\RelicGrid_Distribution.p12"))
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\RelicGrid_AppStore.mobileprovision"))
```

The distribution certificate and profile must belong to the same team and bundle identifier. Keep a secure backup of the `.p12`, its password, and the `.p8` key; Apple only lets you download an API private key once.

## Uploading to TestFlight

After adding all seven secrets, open **Actions → iOS build → Run workflow**, select `main`, and enable **Sign, export, and upload this build to TestFlight**. The workflow also produces the unsigned archive. The signed job imports the certificate and profile on the temporary macOS runner, builds and exports an IPA, uploads it through App Store Connect, and removes temporary signing files.

The iOS marketing/build versions currently match Android (`1.41` / `42`). Before subsequent uploads, increment `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `ios/App/App.xcodeproj/project.pbxproj`; each App Store Connect build number must be unique. Once processing finishes, complete TestFlight compliance questions and invite internal or external testers in App Store Connect.
