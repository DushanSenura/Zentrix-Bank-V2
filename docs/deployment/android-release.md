# Android release build

## One-time: create a release key
```bash
keytool -genkeypair -v -keystore zentrix-release.jks -alias zentrix -keyalg RSA -keysize 2048 -validity 10000
```
Keep the keystore and its passwords somewhere safe and **outside the repository**. If you lose the key you cannot update the app in a store.
Then create `apps/mobile/android/key.properties` (git-ignored):
```
storeFile=/absolute/path/to/zentrix-release.jks
storePassword=...
keyAlias=zentrix
keyPassword=...
```

## Build
```bash
cd apps/mobile
flutter build appbundle --release --dart-define=API_BASE_URL=https://api.staging.example.test     # for a store
flutter build apk --release --dart-define=API_BASE_URL=https://api.staging.example.test           # for side-loading
```
`API_BASE_URL` is baked in at build time and must be **HTTPS**: release builds refuse cleartext traffic (only debug builds allow it).
The app talks to the same `/api` the admin portal uses, so point it at the public address of the staging stack.

Without `key.properties` the release build **fails on purpose**. For a throwaway test artifact on your own device only:
```bash
flutter build apk --release -Pzentrix.allowDebugSigning=true --dart-define=API_BASE_URL=...
```
that APK is signed with the public debug key; never distribute it.

## What the release build does
Code shrinking and resource shrinking are on. Version comes from `pubspec.yaml` (`2.0.0+1`: name+build number; raise the build number for
every upload). Launcher icons come from `infrastructure/scripts/make_icons.py` (re-run it if `assets/brand/bank_logo.png` changes).

## Known build workaround
With the current toolchain (Android Gradle Plugin 9.0.1, Kotlin 2.3.20) Android Lint's release-time `lintVital` check crashes inside Lint itself
(`NoClassDefFoundError: org/jetbrains/kotlin/config/LanguageVersionSettings`), for every module. `android/build.gradle.kts` therefore skips
`lintVital` tasks. That removes Android Lint's release-blocking checks: run `flutter analyze` and the tests, and try removing the workaround
whenever AGP or Kotlin is upgraded.

## Not verified
Release builds have not been installed or run on a physical device or emulator. R8 shrinking can break reflection-based plugins at runtime
only; smoke-test sign-in, a payment, QR scanning, biometric unlock and a statement share on a real device before distributing.
