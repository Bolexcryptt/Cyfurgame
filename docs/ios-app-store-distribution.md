# App Store distribution build

The separate **iOS App Store distribution** GitHub Actions workflow creates a Release archive signed for App Store distribution, exports an IPA, validates it, and uploads it as the `relicgrid-ios-app-store-ipa` workflow artifact. It is manually triggered from **GitHub → Actions → iOS App Store distribution → Run workflow** and does not replace the personal Sideloadly workflow.

The workflow preserves the Xcode project Bundle ID `com.relicgrid.cyfurgame`. On dispatch, enter a unique `ios_build_number`: check the app's existing builds in App Store Connect and use the next unused build number. The project's current marketing version remains `1.41`; the build number is overridden only for that workflow run and no Xcode project file is edited. App Store Connect upload is an optional checkbox and defaults to off, so the IPA artifact is available for inspection first.

## Apple prerequisites

You need an active Apple Developer Program membership, an App Store Connect app record for `com.relicgrid.cyfurgame`, and permission to create distribution signing assets and upload builds.

In the Apple Developer portal:

1. Create or select an **Apple Distribution** certificate for the team. Export its certificate and private key together as a password-protected `.p12`.
2. Create an **App Store** provisioning profile for `com.relicgrid.cyfurgame`, using that distribution certificate. This must be an App Store profile, not Development or Ad Hoc.
3. Find the Apple Developer Team ID.

In App Store Connect, create an API key with permission to upload builds if you want to enable automatic upload. The API key is optional for building and downloading the IPA.

## GitHub Actions secrets

Add these repository secrets under **Settings → Secrets and variables → Actions → New repository secret**. Never put credential values in source control or chat.

| Secret | Required for | Value and where to get it |
| --- | --- | --- |
| `IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64` | IPA build | Base64 of the password-protected Apple Distribution `.p12` containing the private key. Export it from Keychain Access on a Mac or have the account holder securely export it. |
| `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | IPA build | The password chosen when exporting the `.p12`. |
| `IOS_PROVISIONING_PROFILE_BASE64` | IPA build | Base64 of the App Store `.mobileprovision` downloaded from the Apple Developer portal. It must match the team, certificate, and `com.relicgrid.cyfurgame`. |
| `APPLE_TEAM_ID` | IPA build | The 10-character Team ID shown in the Apple Developer account membership details. |
| `ASC_API_KEY_ID` | Optional upload only | Key ID for the App Store Connect API key. |
| `ASC_API_ISSUER_ID` | Optional upload only | Issuer ID shown on the App Store Connect API keys page. |
| `ASC_API_PRIVATE_KEY` | Optional upload only | Entire contents of the downloaded API `.p8` file, including its PEM boundary lines. Apple only allows downloading the private key once; keep a secure backup. |

Encode the certificate and profile locally on your Windows PC, then copy each result directly into the corresponding GitHub secret form:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\RelicGrid_Distribution.p12")) | Set-Clipboard
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\RelicGrid_AppStore.mobileprovision")) | Set-Clipboard
```

Run each command separately and paste its clipboard value into the matching secret. The password, Team ID, and API values are entered directly into the appropriate GitHub secret. Do not send any of these values in chat.

The workflow fails with an explicit missing-secret message if required distribution credentials are absent. It validates the profile's team, app identifier, distribution entitlement, and that it is not device-limited before archiving. It also checks the exported IPA's bundle ID, selected build number, signature, embedded profile, and ZIP integrity before publishing the artifact. A successful export is not represented as an App Store upload unless the optional upload checkbox is enabled and App Store Connect accepts it.

## Run and download

1. Add the four required distribution secrets above.
2. Open **Actions → iOS App Store distribution → Run workflow** and select `main`.
3. Enter the next unused iOS build number from App Store Connect.
4. Leave **Upload to App Store Connect** unchecked to inspect the IPA before uploading.
5. After the run succeeds, download `relicgrid-ios-app-store-ipa` from the run's **Artifacts** section.
6. To automate upload in a separate run, first add all three `ASC_API_*` secrets, select the upload checkbox, and run again.

App Store Connect must finish processing an uploaded build before it can be selected for a release or TestFlight testing.
