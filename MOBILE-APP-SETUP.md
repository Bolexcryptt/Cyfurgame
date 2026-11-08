# Android and iOS app setup

The native apps package the existing game from `dist/`; they do not load the
production website in a browser. Vite bundles Three.js, Supabase, and the
Solana client, while the build copies the game's videos, audio, textures, and
other local runtime assets into the app.

## Requirements

- Node.js 22 or newer and npm.
- Android builds: Android Studio, JDK 21, and the Android SDK
  installed through Android Studio.
- iOS builds: macOS with Xcode and an Apple developer team for device signing
  and TestFlight distribution. Xcode is not available on Windows.

## Build and sync

```powershell
npm ci
npm run build
npx cap sync
```

`npm run cap:sync` combines the web build and Capacitor sync.

Open the native projects with `npm run android` or `npm run ios`. For Android
release builds, create and back up a dedicated upload keystore. Keep the
keystore and its passwords out of source control. Add these values to
`%USERPROFILE%\.gradle\gradle.properties` (outside the repository):

```properties
CYFUR_RELEASE_STORE_FILE=C:/Users/your-name/.android/cyfur-release-key.jks
CYFUR_RELEASE_STORE_PASSWORD=your-keystore-password
CYFUR_RELEASE_KEY_ALIAS=cyfur-upload
CYFUR_RELEASE_KEY_PASSWORD=your-key-password
```

Then run `.\gradlew.bat assembleRelease bundleRelease` from the `android`
directory. The signed APK and AAB are written to
`android/app/build/outputs/apk/release/app-release.apk` and
`android/app/build/outputs/bundle/release/app-release.aab`. Release builds
fail rather than silently using the debug key when signing properties are
missing. Back up the upload key and passwords securely; future app updates
must use the same signing identity.

For iOS, open the workspace on macOS after running CocoaPods, select the App
target, set the signing team, then archive and upload it for TestFlight.

The native app calls the existing production API at
`https://cyfurpuzzlegame.vercel.app`. Server CORS accepts only the Capacitor
Android/iOS local origins in addition to the configured web origin. Do not put
server secrets in the app.

Phantom mobile handoffs return through the `relicgrid://` app URL scheme.
That scheme is registered in the generated Android and iOS projects.
The installed app name is RelicGrid. Native screens start and return to
portrait. The company introduction stays portrait; the game video requests
landscape and restores portrait when it ends, is skipped, or cannot play.

Android launcher icons are generated from the owner-provided
`relicgrid-icon.png` source and included as density-specific legacy icons and
adaptive-icon foreground resources. The 512 × 512 Play listing image is
`relicgrid-icon-512.png`; the source image is preserved unchanged.

## Before store submission

- Build and exercise both platforms on real devices, including video/audio,
  touch input, WebGL, screen rotation, safe areas, Supabase login/recovery,
  leaderboard, and Phantom handoff.
- Set up app icons, launch artwork, privacy disclosures, store metadata,
  signing credentials, and Apple/Google developer accounts.
- Review release dependency advisories and store policies. A successful web
  bundle or native project sync is not an APK, an iOS build, or device testing.
