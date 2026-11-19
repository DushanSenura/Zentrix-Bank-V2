# iOS build preparation

iOS builds need macOS with Xcode; this repository was developed on Windows, so **no iOS build has been produced or run**. What is prepared:

* The Flutter iOS project (`apps/mobile/ios`) with all required launcher icon sizes generated from the brand mark.
* Bundle display name and version come from `pubspec.yaml` (`2.0.0+1`).
* `Info.plist` already contains customer-worded `NSCameraUsageDescription` (QR scanner) and `NSFaceIDUsageDescription` (biometric unlock).

## On a Mac (or macOS CI runner)
```bash
cd apps/mobile
flutter pub get
cd ios && pod install && cd ..
flutter build ipa --release --dart-define=API_BASE_URL=https://api.staging.example.test --export-method ad-hoc   # or app-store
```
You need an Apple Developer account, a bundle identifier you own (change `lk.zentrix.zentrix_bank` in Xcode if it is not yours), signing
certificates and a provisioning profile. Release iOS builds require HTTPS (App Transport Security); do not add exceptions.

A GitHub Actions macOS job is the usual way to do this without a local Mac; none is configured here because it would need your signing
secrets.
