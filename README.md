# Sandroid

Run a real Android phone (with Google Play) on your computer and use it from your iPhone — including an **iPhone 6 on iOS 12**.

```
 iPhone (Sandroid app)  ── Wi-Fi, TCP port 8080 (no web browser, no port 80) ──  Computer (node server.js)
   video + sound  ◀────────────────────────────────────────────────────────────   Android 14 + Google Play
   touch, keyboard, files, camera  ───────────────────────────────────────────▶   (Android emulator)
```

Android runs on the computer, not on the phone. The phone only shows the screen, plays the sound and sends your touches, so the iPhone 6's 1 GB of RAM is enough.

## 1. Start the server on your computer

You need:

- Windows 10/11 (64-bit), macOS (Intel or Apple Silicon) or Linux (64-bit Intel/AMD)
- 8 GB RAM or more, about 12 GB free disk space
- [Node.js 18 or newer](https://nodejs.org)
- Hardware virtualization: on Windows turn on **Windows Hypervisor Platform** (Turn Windows features on or off); on Linux `/dev/kvm` must work

```bash
cd server
node server.js
```

The first start downloads and installs everything by itself: Java (only if you don't have Java 17+), the Android SDK tools, the emulator and Android 14 with Google Play (about 2–3 GB). With older Google SDK tools it asks you to accept the Android SDK licenses once (or start with `--accept-licenses`); the newer tools (Android CLI) skip that step. After that it starts Android and prints:

```
  Name:  my-pc
  PIN:   482913
  Port:  8080 (TCP for the app, UDP for auto-discovery)
  Address: 192.168.1.20:8080   (Wi-Fi)
```

If your firewall asks, allow Node.js on **private networks** (TCP and UDP port 8080).

Everything is stored in `server/data/` (settings in `server/data/config.json`).

## 2. Build the iPhone app with Codemagic

1. Sign in at [codemagic.io](https://codemagic.io) and add this GitHub repository.
2. Codemagic reads `codemagic.yaml` and shows the workflow **Sandroid IPA (iOS 12, iPhone 6)**. Start a build (or just push to `main`).
3. Download **Sandroid.ipa** from the build's artifacts.

Xcode is pinned to **16.4** on purpose: apps built with Xcode 26 or newer crash on iOS 12. The build also checks the finished IPA (arm64, minimum iOS 12.0, no iOS 13+ frameworks) and fails if anything would not run on an iPhone 6.

If you turn on GitHub Actions for your account, the same build also runs there (`.github/workflows/build.yml`) and attaches the IPA to each run.

## 3. Install it on the iPhone

The IPA is not signed for your phone yet. On iOS 12 use **[Sideloadly](https://sideloadly.io)** on your computer:

1. Connect the iPhone with a cable, open Sideloadly, drop `Sandroid.ipa` in, enter your Apple ID, press Start.
2. On the iPhone: Settings → General → Profiles & Device Management → trust your Apple ID.

With a free Apple ID the app must be re-installed every 7 days (Sideloadly can do it automatically). AltStore also works, but only on iOS 12.2 or newer.

## 4. Use it

Open **Sandroid** on the iPhone (same Wi-Fi as the computer). It finds the computer by itself — tap it and type the PIN. If it isn't found, tap **Enter address…** and type the IP from the server window.

- **Touch** works like a normal phone, including multi-touch.
- **Google Play**: open the Play Store inside Android and sign in with your Google account.
- **☰ button** (drag it anywhere): keyboard, Back / Home / Recent apps, notifications, rotate, restart Android, disconnect.
- **Keyboard**: the Android keyboard appears inside the stream when you tap a text field. You can also use the iPhone keyboard from the ☰ menu (supports å, ä, ö and emoji, plus Esc, Tab and arrow keys).
- **Sound** plays on the iPhone.
- **Clipboard**: text copied in Android is copied on the iPhone; "Paste iPhone clipboard" sends it the other way.
- **Files to Android**: "Send a file or app" (from the Files app) or "Send a photo or video". Files go to Android's `Download` folder. `.apk`, `.apks` and `.xapk` files are installed as apps. You can also use *Share → Sandroid* from other apps.
- **Files from Android**: "Get a file from Android" lets you browse Android's storage. Files are saved in *Files → On My iPhone → Sandroid → From Android* and the share sheet opens so you can save photos to the Photos app.
- **Camera**: "Use iPhone camera" makes the iPhone camera Android's back camera (see below).

### Camera (Linux server only)

Android's camera is fed through a virtual webcam, which needs Linux:

```bash
sudo apt install v4l2loopback-dkms ffmpeg
sudo modprobe v4l2loopback video_nr=42 card_label=SandroidCam exclusive_caps=1
```

Then start (or restart) the server. On Windows and macOS the rest works; the camera option tells you it isn't available.

## Server options

```
node server.js --help

  --accept-licenses   accept the Android SDK licenses without asking
  --serial=SERIAL     stream an existing Android device/emulator (from "adb devices")
  --show-window       also show the Android window on this computer
  --gpu=MODE          emulator GPU: auto, host, swiftshader_indirect
  --no-camera         don't set up the iPhone camera passthrough
  --no-audio          don't stream sound
  --new-pin           make a new PIN
  --name=NAME         name shown in the iPhone app
  --data=DIR          where Android and settings are stored (default: ./data)
```

Picture quality and screen size are in `server/data/config.json` (`stream.videoBitRate`, `stream.maxFps`, `android.width/height`). The default Android screen is 720×1280, the same shape as the iPhone 6 screen.

## Troubleshooting

| Problem | Fix |
|---|---|
| The app doesn't find the computer | Same Wi-Fi? Allow Node.js in the firewall. Or type the IP with *Enter address…* (on iOS 14 and newer, automatic search may be blocked by iOS; typing the IP always works) |
| "Wrong PIN" | Use the PIN in the server window. `--new-pin` makes a new one. |
| Linux: `/dev/kvm` error | Enable VT-x/AMD-V in BIOS, `sudo apt install qemu-kvm`, `sudo usermod -aG kvm $USER`, log out and in. Most cloud servers can't run the emulator. |
| Windows: very slow or won't start | Turn on *Windows Hypervisor Platform*, restart the PC. |
| Picture stutters | Move closer to the router or lower `stream.videoBitRate` (e.g. `3000000`). |
| First start takes long | Normal: the first Android boot takes a few minutes. Later starts are faster. |

## How it works

- `server/` — Node.js, no npm packages needed. Installs the Android SDK, creates the virtual phone, starts it, and runs [scrcpy-server](https://github.com/Genymobile/scrcpy) 5.0.1 (Apache-2.0, downloaded and checksum-verified at first start) inside Android for H.264 video, PCM audio and touch input. The iPhone talks to it with a small binary protocol on TCP 8080 (`server/lib/protocol.js`); discovery is a UDP broadcast on port 8080.
- `ios/` — the iPhone app in Objective-C, built straight with `clang` for iOS 12 (`ios/build-ipa.sh`). Video is decoded by the iPhone's hardware decoder.
- `npm test` in `server/` runs the tests, including an end-to-end test with a fake Android device and a fake iPhone.

The PIN protects the server on your network. Don't open port 8080 to the internet.
