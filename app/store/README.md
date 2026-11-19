# Publishing AuthDeck

How to get the builds from `npm run release:android` and `npm run release:ios` onto Google Play and the App Store. Everything the stores ask for is in this folder:

| File | What it's for |
| --- | --- |
| `listing.md` | Store name, subtitle, descriptions, keywords, category, age rating answers |
| `privacy.md` | The privacy policy. It must be hosted at a public URL (see below) |
| `data-safety.md` | Answers for Play's Data safety form and Apple's App Privacy section |
| `review-notes.md` | Notes for App Review and Play's app access section |
| `play-icon.png` | The 512 × 512 icon Play asks for on the listing (made by `npm run icons`) |

## Identity

| | |
| --- | --- |
| App name | AuthDeck |
| iOS bundle id / Android package | `dev.authdeck.app` |
| Version | 0.2.0 (iOS build 3, Android versionCode 3) |

The bundle id and package name can never change once a store has accepted a build, so check you're happy with `dev.authdeck.app` before the first upload. Bump `version`, `ios.buildNumber` and `android.versionCode` in `app.json` for every upload; both stores refuse a build number they have already seen.

## What you have to do yourself

These need your accounts, money or judgment; nothing in the repo can do them.

1. **Apple Developer Program** membership (USD 99 a year) at developer.apple.com. Your **Team ID** is under Account › Membership details. The iOS script needs it as `APPLE_TEAM_ID`.
2. **Google Play Console** developer account (one-off USD 25) at play.google.com/console. New personal accounts must run a closed test with at least 12 testers for 14 days before they can publish to production.
3. **Host the privacy policy.** The repo is private, so a link into it won't work for the stores or for users. Put `privacy.md` somewhere public (GitHub Pages from a public repo, a gist, your own site) and fill in the contact email in it first.
4. **Host the desktop agent publicly.** Reviewers and users need to download AuthDeck Agent. Release assets of a private repo aren't downloadable by them.
5. **Screenshots** and a **demo video** (see below). App Review can't pair a computer, so the video is what they judge the app by.
6. **Play feature graphic**, 1024 × 500 PNG or JPEG, required for the Play listing.

## Google Play

### Signing

The release scripts sign with your upload key: `~/.config/authdeck-signing/authdeck-release.p12`, configured through `AUTHDECK_UPLOAD_*` in `~/.gradle/gradle.properties`. `release-android.sh` prints the certificate's owner and SHA-256 after every build. If it shows `CN=Android Debug`, the properties weren't found and Play will reject the bundle.

Use **Play App Signing** (the default for new apps): Google holds the key that signs what users install, and this key only proves uploads come from you. When you create the app, choose "Use Google-generated key" and upload the `.aab`; Play registers this key as the upload key from that first upload.

Back up the `.p12` and its passwords somewhere other than this Mac. If the upload key is lost, Play support can reset it, but that takes days.

### Steps

1. `npm run release:android` writes `dist/AuthDeck-0.2.0-android.aab` (for Play) and `.apk` (for sideloading).
2. Play Console › Create app: name AuthDeck, App, Free, accept the declarations.
3. Fill in the **App content** section:
   - Privacy policy: your hosted URL.
   - App access: "All or some functionality is restricted", with the instructions from `review-notes.md`.
   - Ads: no ads.
   - Content rating: the questionnaire answers in `listing.md`.
   - Target audience: 18 and over (it's a tool for people who use a computer for work; picking ages under 13 brings in the Families policy).
   - Data safety: `data-safety.md`.
   - Government app, financial features, health: no.
4. **Store listing**: texts from `listing.md`, `play-icon.png`, the feature graphic and screenshots. Category: Productivity.
5. Testing › Closed testing: create a track, upload the `.aab`, add testers. Once the 14 days with 12 testers are done, promote it to Production and send it for review.

## App Store

### Steps

1. Create the App ID: developer.apple.com › Identifiers › `dev.authdeck.app`. Xcode's automatic signing will also do this on the first archive.
2. App Store Connect › Apps › New App: iOS, name AuthDeck, bundle id `dev.authdeck.app`, a SKU of your choice (for example `authdeck`).
3. `APPLE_TEAM_ID=<your team id> npm run release:ios` archives with automatic signing and writes `dist/AuthDeck-0.2.0-ios.ipa`. Xcode must be signed in to your Apple account (Xcode › Settings › Accounts). Without `APPLE_TEAM_ID` the script makes an unsigned `.ipa`, which is only useful to check that the app builds.
4. Upload the `.ipa` with Apple's Transporter app, or open `dist/AuthDeck-0.2.0-ios.xcarchive` in Xcode's Organizer and choose Distribute App.
5. In App Store Connect fill in:
   - App Information: subtitle, category (Developer Tools, secondary Productivity), age rating answers from `listing.md`.
   - App Privacy: privacy policy URL and the answers in `data-safety.md` ("Data Not Collected").
   - The version page: description, keywords, support URL, screenshots, and the build.
   - App Review Information: notes from `review-notes.md`, the demo video link, and your contact details. No sign-in is needed.
6. Test with TestFlight first, then Submit for Review.

### Export compliance

`app.json` sets `ios.config.usesNonExemptEncryption: false` (written to Info.plist as `ITSAppUsesNonExemptEncryption`), so App Store Connect won't ask about encryption on each build.

**Check this before submitting 0.3.0.** Since 0.3.0 the app runs its own encryption, not just what iOS provides:
- the connection to the agent: Noise with X25519 and ChaCha20-Poly1305, and CPace for PIN pairing
- the 2FA vault: AES-256-GCM, Ed25519 signatures, HKDF
- env sets (0.4.0): the same algorithms (AES-256-GCM values, Ed25519 signatures, keys sealed with ristretto255 and HKDF), to protect and share the user's own `.env` secrets

These are standard, published algorithms used to authenticate and to protect the user's own data, which usually puts an app under the mass-market exemption. Still:
1. Answer App Store Connect's export compliance questions for this release.
2. Check whether a yearly self-classification report is needed.
3. Keep the key `false` only if the answers say the app qualifies.

The Face ID purpose string (`NSFaceIDUsageDescription`) is already in `app.json`.

### iOS privacy manifest

`app.json` › `ios.privacyManifests` becomes the app's `PrivacyInfo.xcprivacy`: no tracking, no tracking domains, no collected data. Most dependencies ship their own manifest (React Native, AsyncStorage, expo-constants, expo-device, expo-file-system, expo-system-ui). The app-level entries cover the libraries that use required-reason APIs without one:

- `UserDefaults` CA92.1: expo-sharing reads and writes app defaults.
- `FileTimestamp` C617.1: expo-sharing reads creation dates of files in the app's own container.
- `FileTimestamp` 3B52.1: expo-document-picker reads the modification date of a file the user picked (deck backup import).

When you add a native dependency, check whether it ships a `PrivacyInfo.xcprivacy`; if it doesn't and it uses one of Apple's required-reason APIs, add the reason here.

## Screenshots

Take them from the real app with your own keys, not mock-ups. PNG or JPEG, no transparency.

### App Store

The app supports iPad, so both sets are required. Upload the largest size; App Store Connect scales them down for smaller devices. 1 to 10 per set.

| Device | Portrait | Landscape |
| --- | --- | --- |
| iPhone 6.9" (iPhone 16/17 Pro Max) | 1320 × 2868 (or 1290 × 2796) | 2868 × 1320 (or 2796 × 1290) |
| iPad 13" (iPad Pro M4/M5) | 2064 × 2752 (or 2048 × 2732) | 2752 × 2064 (or 2732 × 2048) |

The iOS Simulator's File › Save Screen writes these sizes exactly when you pick the matching device.

An optional app preview video can go next to the screenshots: 15 to 30 seconds, recorded from the app itself.

### Google Play

| Asset | Size | Required |
| --- | --- | --- |
| App icon | 512 × 512 PNG (`play-icon.png`) | Yes |
| Feature graphic | 1024 × 500 PNG or JPEG | Yes |
| Phone screenshots | 2 to 8; each side 320 to 3840 px, long side at most twice the short; 1080 px or more on the short side to be eligible for recommendations | Yes, at least 2 |
| 7" tablet screenshots | Up to 8; each side 320 to 3840 px | Recommended (the app supports tablets) |
| 10" tablet screenshots | Up to 8; each side 1080 to 7680 px | Recommended; needed to be featured for tablets |

## Before every release

- [ ] `npm run icons` if the icon changed, and commit the PNGs.
- [ ] Bump `version`, `ios.buildNumber`, `android.versionCode` in `app.json`.
- [ ] `npm run release:android` shows your upload key's CN and SHA-256, not the debug key.
- [ ] `npx expo config --type prebuild` shows the permissions, privacy manifest and `targetSdkVersion` you expect.
- [ ] Google Play requires new apps and updates to target an Android API level released within the last year. `targetSdkVersion` is 36 (in the `expo-build-properties` plugin); raise it when Play's deadline for the next level arrives.
- [ ] Privacy policy and data safety answers still match what the app does (for example once team vaults ship; see "Revisit when" in `data-safety.md`).
