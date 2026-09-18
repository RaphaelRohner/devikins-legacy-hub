# SETUP.md — Installing and running Devikins Legacy Companion

This file assumes zero prior experience with React Native, Expo, or this
project. Follow it top to bottom the first time; after that you'll only
need the "Everyday start/stop" section.

## What's already installed (you don't need to redo this)

These were run once, in a real Terminal window, to get the project to its
current state:

1. `npx create-expo-app@latest app --template blank` — created the `app/`
   folder and installed the core Expo + React Native framework.
2. `npx expo install expo-sqlite @react-native-picker/picker expo-file-system react-native-safe-area-context` —
   added the extra libraries the app needs:
   - **expo-sqlite** — lets the app keep a small database file on your
     phone, so your NFT data is saved locally and doesn't need to be
     re-fetched from the internet every time you open the app.
   - **@react-native-picker/picker** — the dropdown menu component used
     for the category filters (rarity, class, etc.).
   - **expo-file-system** — downloads and saves each NFT's picture to
     your phone's own storage, so images keep showing up even if the
     game's image server is briefly slow or unreachable.
   - **react-native-safe-area-context** — keeps the app's content clear
     of the phone's notch/status bar/home indicator on all screen shapes;
     replaces an older built-in tool Expo has since marked deprecated.

If you ever need to set this project up on a different computer, or after
deleting `node_modules`, re-running those two commands (from inside the
`app/` folder for the second one) will put you back here.

## What you need on your phone

The **Expo Go** app, from the App Store or Google Play. You mentioned you
already have this installed — nothing else is needed on the phone side.

## Everyday start/stop

**To start the app:**

1. Open Terminal.
2. Go to the app folder:
   ```
   cd ~/Documents/devikins-app/app
   ```
   (adjust the path if your project lives somewhere else)
3. Start the development server:
   ```
   npx expo start
   ```
4. A QR code will appear directly in the Terminal window.
5. Open the **Expo Go** app on your phone and scan that QR code
   (Expo Go has a built-in scanner — on iPhone you can also just use the
   regular Camera app, which will offer to open it in Expo Go).
6. The app will build and open on your phone. The first time, this can
   take a minute or two — subsequent opens are much faster.

**To stop the app:**

- Click back into the Terminal window running `npx expo start` and press
  `Ctrl + C`.
- Closing the Terminal window also stops it.
- Closing the app on your phone does *not* stop the server on your
  computer — you still need to `Ctrl + C` in Terminal, or it'll keep
  running (harmlessly) in the background.

**To reload the app on your phone** without restarting the whole server
(useful if it looks stuck or you just changed code):

- Shake your phone — Expo Go shows a "Reload" option.
- Or, in the Terminal window, press `r`.

## First test run

Tap the **Wallets** button (next to Fetch/Update at the top), tap **Add**
after pasting in the wallet address
`klv1...(your wallet address)`, then tap
**‹ Back to Home** and **Fetch/Update**. That's a small wallet with just
one NFT in each of the three collections, so it's quick to fetch and easy
to check that everything (all three tabs, filters, images) is showing up
correctly.

You can add more than one wallet address from that same Wallets screen -
Fetch/Update always pulls from every wallet address listed there, not
just the most recent one.

## Common problems

**"My phone and computer can't connect" / QR code scan does nothing**

- Your phone and computer need to be on the **same Wi-Fi network**. This is
  the #1 cause of connection failures. Corporate/school/guest Wi-Fi
  networks often block devices from seeing each other even when connected
  to the same network — if you're on one of those, try a home network or
  a phone hotspot instead.
- If you're sure you're on the same network and it still won't connect, in
  the Terminal where `npx expo start` is running, press `s` to switch to
  "tunnel" mode, which routes the connection over the internet instead of
  your local network (slower, but works around most network issues). You
  may need to wait a few seconds and re-scan the QR code after switching.

**QR code won't scan**

- Make sure your phone's camera/Expo Go has focus on a plain, evenly-lit
  view of the screen — a glossy monitor can create glare that breaks the
  scan. Zooming your terminal window in (bigger QR code) sometimes helps.
- As a fallback, Expo Go has a "Enter URL manually" option — the
  Terminal output above the QR code shows a URL starting with `exp://`
  that you can type in there instead.

**The app crashes immediately on open, or shows a red error screen**

- Take a screenshot or note down the exact error text — it's usually
  specific enough to point straight at the problem.
- Try reloading first (shake phone → Reload, or press `r` in Terminal) —
  sometimes it's a one-off hiccup from the very first connection.
- If it keeps happening, stop the server (`Ctrl+C`), delete the
  `node_modules` folder inside `app/`, and reinstall:
  ```
  cd ~/Documents/devikins-app/app
  rm -rf node_modules
  npm install
  npx expo start
  ```
- If the error mentions a specific file under `src/`, that's the file to
  look at first — see ARCHITECTURE.md to figure out what that file is
  responsible for.

**"Fetch" seems stuck / progress bar isn't moving**

- The metadata API this app depends on (a third-party Lambda, not
  something we control) is known to be slow and occasionally times out on
  individual NFTs — this is expected and the app retries automatically
  behind the scenes. A stall of a few seconds per item is normal for a
  large wallet. If it's genuinely frozen (no progress for several
  minutes), tap "Stop", then try Fetch again — the app remembers which
  NFTs it already got, so a second attempt won't start from zero.

**Nothing shows up after fetching, but I know the wallet has NFTs**

- Double check the address was pasted correctly (Klever addresses start
  with `klv1`).
- Remember: this app only shows NFTs sitting in the wallet address(es)
  you've added via the Wallets screen — not any in-game custodial wallet,
  and not the game's main contract address. See NOTES.md's "three-wallets
  confusion" section if this is surprising.

## Building a real, installable app (an APK) instead of using Expo Go

Everything above runs the app through Expo Go, which is great for
day-to-day development but requires the Expo Go app and a live connection
to your computer's dev server. If you'd rather have a standalone app file
you can install directly on an Android phone (and keep using even when
your computer isn't running anything), you can build a real `.apk` file
using Expo's own free cloud build service, called **EAS Build**. This
needs a real internet connection and a (free) Expo account, so it's done
from a real Terminal window on your computer, not from within this
assistant's sandbox.

**One-time setup:**

1. Install the EAS command-line tool (only needs to be done once per
   computer):
   ```
   npm install -g eas-cli
   ```
2. Log in with a free Expo account (this opens a browser to sign up if
   you don't already have one — the same account system Expo Go itself
   uses):
   ```
   eas login
   ```

**Building the APK:**

3. From inside the `app/` folder:
   ```
   cd ~/Documents/devikins-app/app
   eas build -p android --profile preview
   ```
   The `preview` profile (already set up in `eas.json`) is configured to
   produce a plain installable `.apk` file rather than the `.aab` format
   the Google Play Store requires — that distinction matters because a
   personal, non-commercial app like this one has no reason to go through
   the Play Store at all.
4. The first time you run this, it'll ask a couple of setup questions
   (like linking this project to your Expo account) — answer with the
   defaults unless you have a reason not to.
5. The actual build happens on Expo's servers, not your computer, and
   typically takes several minutes. You'll see a link to a build details
   page — once it's done, that page has a **Download** button for the
   finished `.apk` file.
6. Building is free for personal projects like this one, within Expo's
   free-tier limit of 15 Android builds per month — plenty for occasional
   updates.

**Installing the APK on your phone:**

7. Get the downloaded `.apk` file onto your phone (e.g. email it to
   yourself, use AirDrop, or open the build details page's download link
   directly in your phone's browser).
8. Tap the file to install it. Since this isn't coming from the Google
   Play Store, Android will likely show a one-time warning about
   installing from an "unknown source" — this is expected for any app
   installed this way (not just this one), and just needs to be allowed
   once.
9. From then on, it's a normal app icon on your phone — no Expo Go, no
   computer, no dev server required. To get a newer version onto your
   phone later (after more changes), just repeat the build steps above
   and reinstall the new `.apk` over the old one.

## Sharing this project (and its APK) on GitHub

This project now *is* a GitHub-ready repository: it lives at
`~/Documents/devikins-app` (the folder that contains this `app/` folder,
plus `NOTES.md` and a couple of research scripts), it's already tracked
with git, and the first commit has been made. What's left is a short,
one-time step to create the actual home for it on GitHub's website and
connect this folder to it. This step involves talking to github.com over
the internet, so it needs to be run from your **regular Mac Terminal**
(Spotlight → type `Terminal` → open it) — not from within a chat with
this assistant, which can't reach github.com directly.

**1. Create the empty repository on GitHub's website**

- Go to [github.com/new](https://github.com/new) (sign in as
  `RaphaelRohner` first if you aren't already).
- Repository name: `devikins-legacy-companion` (or anything else you'd
  prefer — it doesn't have to match the app name).
- Leave it **Public** (or switch to Private if you'd rather - either
  works, and you can change this later in the repo's Settings).
- **Do not** check "Add a README", "Add .gitignore", or "Choose a
  license" - this project already has a `.gitignore` and its first
  commit, and starting the GitHub repo completely empty avoids a
  conflict when we connect it.
- Click **Create repository**. GitHub will show you a page with some
  setup commands - you can ignore those, since the commands below cover
  it.

**2. Connect this folder to it and push**

Open Terminal and run these, one at a time:

```
cd ~/Documents/devikins-app
git remote add origin https://github.com/RaphaelRohner/devikins-legacy-companion.git
git push -u origin main
```

(If you picked a different repository name in step 1, swap it into that
second line.)

**3. Authenticating**

GitHub no longer accepts your regular account password for this - the
first time you push, it'll prompt for a username and password in the
Terminal, and you'll need to give it a **Personal Access Token** instead
of your real password:

- Go to
  [github.com/settings/tokens](https://github.com/settings/tokens) →
  **Generate new token** → **Generate new token (classic)**.
- Give it any name (e.g. "Mac push access"), leave the expiration at its
  default or pick something like 90 days, and check the **repo**
  checkbox (this grants exactly what's needed to push code - nothing
  more).
- Click **Generate token** at the bottom, then **copy the token
  immediately** - GitHub only shows it once.
- Back in Terminal, when `git push` asks for:
  - **Username**: `RaphaelRohner`
  - **Password**: paste the token (not your real GitHub password)
- Your Mac's Keychain will remember this after the first successful
  push, so you shouldn't have to paste it again for future pushes from
  this folder.

Once that finishes, refreshing the repository's page on github.com
should show all of this project's files.

**Publishing future changes**

Any time changes are made and you'd like to update the GitHub copy to
match, the same three-line pattern (minus the `remote add`, which is
only needed once) does it:

```
cd ~/Documents/devikins-app
git add -A
git commit -m "short description of what changed"
git push
```

**Attaching a built APK to a Release**

Once the repo exists on GitHub and you have a built `.apk` (see the
sections above), go to the repo's page → **Releases** (right-hand
sidebar) → **Create a new release** → give it a tag like `v1.0` → drag
the `.apk` file into the attachments area at the bottom → **Publish
release**. Anyone with the repo link (if public) can then download the
`.apk` straight from that release page, without needing GitHub, EAS, or
this assistant at all.


## Building an APK completely locally, with no cloud service at all

The EAS Build steps above are the easiest path, but they do rely on
Expo's own free cloud service to actually compile the app - if you'd
rather build entirely on your own Mac with nothing going out to any
third party (the same idea as building a Python app locally with
something like Buildozer, just for a JavaScript/React Native project
instead of a Python one), that's possible too. It's more one-time setup
work than the EAS path, since your Mac needs to have the real Android
build tools installed rather than borrowing Expo's, but once that's done
nothing about the actual build ever leaves your computer.

**One-time setup (this is the heavier part):**

1. Install **Android Studio** (free, from developer.android.com) - this
   is what brings the Android SDK, build tools, and (in current versions)
   a bundled Java (JDK) onto your Mac. It's a multi-gigabyte download and
   its first-run setup wizard takes a while, but it only needs doing
   once.
2. Open Android Studio at least once and let its setup wizard finish
   (this is what downloads the actual SDK components and accepts their
   license agreements) - you don't need to create or open any project in
   it, just let the initial setup complete.

**Turning this project into a real native Android project:**

3. From inside the `app/` folder:
   ```
   npx expo prebuild --platform android
   ```
   This generates a genuine `android/` folder - a completely standard
   Android Studio/Gradle project, no different in kind from any other
   Android app - built from this project's `app.json` settings (name,
   icon, package identifier, etc.) and its native modules
   (`expo-sqlite`, `expo-file-system`, and so on already installed).
   From this point on, the `android/` folder is a real, ordinary Android
   project that Gradle (which comes bundled inside it as a wrapper
   script) can build without needing Expo's tools involved at all.

**Building the APK:**

4. For a quick build to test on your own phone, with zero extra signing
   setup required:
   ```
   cd android
   ./gradlew assembleDebug
   ```
   This produces `android/app/build/outputs/apk/debug/app-debug.apk`,
   automatically signed with a temporary "debug" key Android generates
   for you - fine for installing on your own phone, not meant for
   handing out further since every developer's debug key is different
   (an app signed with one debug key can't be updated in place by a
   build signed with a different one).
5. For a build meant to last (e.g. one you'll keep reinstalling updates
   over, or eventually hand to someone else), generate your own signing
   key once:
   ```
   keytool -genkey -v -keystore my-upload-key.keystore -alias my-key-alias -keyalg RSA -keysize 2048 -validity 10000
   ```
   (this asks a few questions - a password and some optional identity
   details - and produces a `.keystore` file; keep this file and its
   password somewhere safe, since you'll need the *same* key for every
   future update if you want phones to accept the update over the
   existing install rather than needing an uninstall/reinstall). Move it
   into `android/app/`, then tell Gradle about it by adding these four
   lines to `android/gradle.properties`:
   ```
   MYAPP_UPLOAD_STORE_FILE=my-upload-key.keystore
   MYAPP_UPLOAD_KEY_ALIAS=my-key-alias
   MYAPP_UPLOAD_STORE_PASSWORD=<the password you chose>
   MYAPP_UPLOAD_KEY_PASSWORD=<the password you chose>
   ```
   and pointing `android/app/build.gradle`'s `signingConfigs`/
   `buildTypes.release` sections at those properties (Claude can wire
   this part up for you once the `android/` folder exists, since it's a
   plain file edit once you've generated the key). Then:
   ```
   ./gradlew assembleRelease
   ```
   produces `android/app/build/outputs/apk/release/app-release.apk`.
6. Install the resulting `.apk` on your phone the same way as the EAS
   Build path above (get the file onto the phone, tap it, allow
   "unknown sources" the first time).

**Worth knowing before choosing this path over EAS Build:**

- This needs real disk space and one real chunk of setup time up front
  (Android Studio itself, plus whatever SDK components it downloads) -
  EAS Build skips all of that by doing the compiling on Expo's servers
  instead.
- Once `npx expo prebuild` has been run, the `android/` folder becomes
  the actual source of truth for native Android settings - ordinary
  JS/UI changes (everything done in this project so far) don't need it
  re-run at all, but a future change to `app.json`'s native config (a
  new icon, a new native library) would need either re-running prebuild
  or manually mirroring the change into the `android/` folder.
- None of this - installing Android Studio, running `expo prebuild`, or
  running Gradle - can be done from within this assistant's own sandbox;
  it all needs your own Mac's Terminal, since it depends on tools (a
  full Android SDK, a JDK, Gradle) that only make sense installed
  locally on a real development machine.
