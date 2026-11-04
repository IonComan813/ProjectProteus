## Downloads

| File | For |
|---|---|
| `Proteus-Setup-<version>-win-x64.exe` | Windows 10 / 11 (64-bit) installer; adds shortcuts to the desktop and Start menu |
| `Proteus-<version>-win-x64.zip` | Windows portable version: unzip and double-click `Proteus.exe` |
| `Proteus-<version>-mac-arm64.dmg` | macOS, Apple silicon (M1 and later) |
| `Proteus-<version>-mac-x64.dmg` | macOS, Intel |
| `Proteus-<version>-linux-x86_64.AppImage` | Linux (64-bit): make it executable and run it |
| `Proteus-<version>-android.apk` | Android 7.0 and later: download and tap to install (installing apps from unknown sources must be allowed) |

> The native apps are not code-signed (paid certificates), and the Android app is not installed from an app store, so you may see a warning on first install or launch:
>
> - **Windows** may show "Windows protected your PC" on first run: click "**More info**" → "**Run anyway**".
> - **macOS** may say the developer cannot be verified: go to System Settings → Privacy & Security and click "**Open Anyway**" at the bottom.
> - **Android** may block installing apps from unknown sources (the wording varies by phone brand): follow the prompt to allow your browser (or file manager) to "install unknown apps", then go back and tap Install.

## Native apps vs. the web version

- The native apps have **no CORS restrictions**, so relay endpoints that don't allow direct browser access work too (on Android, replies from such endpoints appear all at once when they are finished)
- The native apps keep their data separate from your browser. Data from the web version does not show up in the native apps automatically: make a "Full backup (all conversations)" in the web version and load it in the native app

See the [commit history](https://github.com/IonComan813/ProjectProteus/commits/main) for what changed, and the [README](https://github.com/IonComan813/ProjectProteus#readme) for how to use it ([简体中文](https://github.com/IonComan813/ProjectProteus/blob/main/README.zh-CN.md)).

---

Open source under AGPL v3. You need your own API key. The developers bear no legal responsibility for what users enter into or receive from this software.
