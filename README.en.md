# Proteus

[简体中文](README.md) | English

A roleplay chat app for large language models (LLMs), similar in spirit to SillyTavern. Available as native apps (Windows / macOS / Linux and Android) and as a web version.

The interface is available in Simplified Chinese, Traditional Chinese, English and Japanese. On first launch it follows your system language (English if your system language is none of these four); you can switch at any time at the bottom of the settings panel on the right (on Android, tap ⚙ at the top right and scroll to the bottom). Open source under AGPL v3; you need your own API key.

![Screenshot](docs/screenshot.png)

## Download and install

### Native apps: Windows / macOS / Linux (recommended)

Download the latest version from the [Releases page](https://github.com/IonComan813/ProjectProteus/releases):

| File | Description |
|---|---|
| `Proteus-Setup-<version>-win-x64.exe` | Windows installer; adds shortcuts to the desktop and Start menu |
| `Proteus-<version>-win-x64.zip` | Windows portable version: unzip and double-click `Proteus.exe` |
| `Proteus-<version>-mac-arm64.dmg` | macOS, Apple silicon (M1 and later) |
| `Proteus-<version>-mac-x64.dmg` | macOS, Intel |
| `Proteus-<version>-linux-x86_64.AppImage` | Linux: make it executable and run it |
| `Proteus-<version>-android.apk` | Android (7.0 and later), see below |

The Windows / macOS / Linux apps come with a built-in Chromium engine, so no separate browser is needed. Compared with the web version they also offer:

- **No CORS restrictions**: relay endpoints that don't allow direct browser access work too
- **Data kept separate from your browser**: clearing browser data won't delete it, and other web pages can't read Proteus's data

> The native apps are not code-signed (paid certificates), and the Android app is not installed from an app store, so you may see a warning on first install or launch:
>
> - **Windows** may show "Windows protected your PC" on first run: click "**More info**" → "**Run anyway**"
> - **macOS** may say the developer cannot be verified: go to System Settings → Privacy & Security and click "**Open Anyway**" at the bottom
> - **Android** may block installing apps from unknown sources (the wording varies by phone brand): follow the prompt to allow your browser (or file manager) to "install unknown apps", then go back and tap Install

### Native app: Android

Download `Proteus-<version>-android.apk` on your phone and tap it to install. The first time, Android will ask you to allow your browser (or file manager) to install unknown apps; just follow the prompt.

- The interface uses a mobile layout: the artwork becomes a dimmed background behind the chat; tap ⚙ at the top right to open the settings
- Exporting a story, world card or backup opens the system share menu, so you can save it to Files, a cloud drive, or send it to someone
- Like the web version, the Android app is subject to the browser's CORS restrictions: the official Claude, OpenAI and Gemini APIs and OpenRouter all work, but a few relay endpoints that block browser access don't (use the Windows / macOS / Linux app for those)
- Data on your phone and on your computer are separate; use "Full backup (all conversations)" to move it

### Web version

Nothing to install:

1. Download the whole folder (**Code → Download ZIP** on the GitHub page, then unzip it)
2. Double-click `index.html` and open it in Chrome or Edge

When the window is narrower than 1000 pixels (including on a phone browser), the mobile layout is used automatically.

### Where is my data stored?

All data (settings, conversations, images, API keys) is stored **only on this device**: the native apps keep it in their own data folder, and the web version keeps it in the browser you opened it with. Data is not shared between devices, or between the native apps and the web version; use "Full backup (all conversations)" to move it.

Switching computers, reinstalling your system or (for the web version) clearing browser data will make your existing content disappear, so export a "Full backup (all conversations)" regularly from "Export / Backup…" on the right.

## Interface

| Area | What it does |
|---|---|
| Left | Artwork. Click to upload; portrait images work best. The image is shown at the width of the left column without stretching: if it is taller than the column, the top and bottom are cropped; if it is shorter, black bars are added above and below. Drag the right edge of the column to resize it (up to about 45% of the window, always leaving enough room for the chat); double-click the edge to reset |
| Middle | The story. At the top you can switch, create, rename and delete conversations; at the bottom is the input box, press **Ctrl + Enter** to send. Drag the edge above the input box to change its height |
| Right | Settings, from top to bottom: System Prompt → World → User's character → Memory length → Model & API → Artwork → Export & backup → Local data → Language |

### Each conversation has its own settings

**The System Prompt, world, user's character, opening and artwork belong to each conversation.** "＋ New chat" copies these from the current conversation (with an empty story); after that the two are independent. Switching back to an older conversation shows that conversation's own settings.

Memory length, Model & API, API keys, interface language and layout are app settings shared by all conversations.

### Opening

When a conversation is completely empty, an "Add opening" button appears below "Send". Click it and the input box switches to editing the opening, with these buttons on the right:

- **Reload**: preview the rendered opening in the chat; the input box keeps its content (Ctrl + Enter does the same). Click again after editing to refresh the preview
- **Confirm**: save the opening and clear the input box; you will then be asked whether to send the opening to the model
- **Cancel**: stop editing the opening

The saved opening is shown at the top of the conversation. Before you send your first message, you can edit or delete it right in the chat; **once the conversation has started, the opening is locked**: it can no longer be edited or deleted, and whether it is sent to the model can no longer be changed (start a new chat for a different opening). Below it is a "Send to the model" checkbox (only the opening has one):

- **Checked**: your first message is merged with the opening and sent to the model as the first message:
  ```
  [Opening]
  …the opening…
  [End of Opening]

  [User]
  …your first message…
  ```
  Once the story has moved on far enough that the first message falls outside the memory length, the opening is no longer sent either.
- **Unchecked**: the opening is only shown in the chat and the model never sees it; your first message is the first message.

The opening is kept in story exports, world cards and full backups.

### Markdown / HTML styling

All messages are rendered as Markdown and HTML, so you can use `<details><summary>` collapsible blocks, custom styles (`<style>`, `style="..."`) and more.

- **The opening** can also use JS (`<script>`)
- **Later messages** (your replies and the model's) have JS disabled and can only use Markdown, HTML and CSS

Each message is shown in its own isolated "sandbox" frame. Its styles and scripts only apply inside that message and don't affect the rest of the interface or other messages. Scripts in the opening cannot read any data from the page (including API keys) and cannot navigate the page away, but they can open new windows (the Windows / macOS / Linux apps open web pages in your system browser).

### Message actions (shown when you hover over a message)

- **Regenerate**: only on the last model reply. Old versions are kept and can be browsed with `‹ 2/3 ›`
- **Edit**: only the **most recent** model reply and the **most recent** user message can be edited
  - Editing a model reply changes the current version directly without regenerating, as if you rewrote that part of the story
  - Editing a user message saves it as a **new version** of that message and generates a reply to it; the old version is kept and can be browsed with `‹ 2/3 ›`
  - To change an earlier message, "Roll back to here" first
- **Versions are grouped**: each version of a user message has its own set of model replies. For example, if message A has replies B and C, and you rewrite it as A′ and get replies D and E, then with A selected you can only switch between B and C, and with A′ selected only between D and E
- **Switching and deleting versions** is only available on the last group (the latest user message and the last model reply), so the story stays consistent. Other versions of earlier messages are still saved, and you can switch between them again after rolling back to them
- **Delete this version**: when a model reply has several versions, deletes the one currently shown
- **Roll back to here**: only on model replies. Keeps this reply and deletes every message after it (not available on the last reply). To go back to the opening, just start a new chat
- **Copy**

While the model is writing you can scroll up and read; the page won't be pulled back to the bottom. To jump to the latest text, click "↓ Back to bottom".

## What is sent to the model each time

```
[system]   System Prompt + full world setting + user's character
[history]  The most recent N rounds of the story (N = memory length, 1–40 rounds; 1 round = one model reply + one user reply)
           If the opening is set to be sent and the conversation's first message is still within range, the opening is merged into it
[user]     Your current reply
```

Older messages are not sent, so the model can't "see" them. A dashed line in the story marks the edge of the memory range; messages above it are still shown, the model just can't see them.
You can type the memory length directly or adjust it with − / ＋. Below it is a rough estimate of how many tokens the next request will use.

## Export and backup

"Export / Backup…" under "Export & backup" on the right offers:

| Option | Includes | Does not include |
|---|---|---|
| Story (TXT / Markdown) | The current conversation's opening and all messages | System Prompt, world, character, artwork |
| World card (JSON, can be encrypted) | The current conversation's System Prompt, world, opening (and whether it is sent to the model), artwork | User's character, story |
| Full backup (this conversation) (JSON, can be encrypted) | Everything in the current conversation: System Prompt, world, user's character, opening (and whether it is sent to the model), story (including every version of every reply), artwork | App settings |
| Full backup (all conversations) (JSON, can be encrypted) | Every conversation (with all its content) and the app settings (memory length, Model & API, interface language, layout, etc.) | API keys |
| Log (last request) (TXT) | The request actually sent to the model the last time (API address, headers, JSON body) and the raw response received, for troubleshooting. Only the last request since the app was opened; not saved | API keys; locked settings from encrypted world cards (shown as "(protected content)") |

"Load world card / backup" accepts world cards and both kinds of full backup:

- **Loading a world card** creates a new conversation with the card's System Prompt, world, opening and artwork, and an empty user's character; existing conversations are not affected
- **Loading a full backup (this conversation)** creates a new conversation exactly as it was backed up; existing conversations are not affected (loading the same backup twice gives two conversations)
- **Loading a full backup (all conversations)** replaces all current conversations and settings (your API keys on this device are kept), restoring the whole app to the state of the backup

Images are stored in the JSON as text (base64), so world cards and backups with images are about a third larger than the images themselves. The artwork can also be downloaded on its own under "Artwork" on the right.

### Encrypted world cards (protecting a creator's settings)

When exporting a world card or full backup you can choose to **encrypt** it with a 4–16 character password (in an encrypted full backup, the story and user's character stay in plain text; only the items below are encrypted):

- Opening the file directly shows only gibberish
- After loading it in Proteus, the System Prompt, world, opening and artwork are **locked**: they can be used normally but not viewed, edited, copied or downloaded; the opening is displayed as usual but cannot be edited, and whether it is sent to the model cannot be changed. The user's character and story are not affected
- Entering the password unlocks it, turning it back into a normal conversation
- A new conversation created from a locked one, and world cards or full backups exported from it, stay encrypted with the original password. You are reminded before exporting that the original password is still needed to unlock it (you are not asked whether to encrypt in this case; normal conversations in a "Full backup (all conversations)" can still be encrypted)
- **A forgotten password cannot be recovered**

> **Limits of encryption**: for the model to use these settings, Proteus has to decrypt them on your device and send them to the model API in plain text, and this project is open source. So encryption only prevents viewing the file directly and copying inside the app; **it cannot stop a technically capable person who is determined to get the content** (for example by inspecting the requests sent to the model, or asking the model to repeat the settings).

## Shared computers

- "Remember API keys on this computer" under "Model & API": when unchecked, API keys only last until you close the page and are never written to this device
- "Clear all local data" under "Local data" on the right: deletes every conversation, setting, artwork and API key Proteus has stored in this browser

## API key security

Proteus runs on your own computer. API keys are stored only locally and never pass through any third-party server, and exported world cards and backups never include them. Please note:

- (Web version) In Chrome, all local web pages opened by double-clicking share the same storage, so in theory a malicious local HTML file could read the data Proteus has saved. Don't open HTML files of unknown origin in the same browser, or use a native app instead; the native apps keep their data completely separate from your browser
- In world cards shared by others, the opening may contain JS. It runs in an isolated sandbox and cannot read your API keys or data, but it can load external resources such as images (and so can tell that someone opened the card)
- The web version has only been tested in Chrome / Edge; Firefox and Safari have unreliable storage support for local web pages

## Supported providers

| Option | Notes |
|---|---|
| Anthropic (Claude) | Calls Claude directly |
| OpenAI | |
| Google Gemini | Uses Gemini's OpenAI-compatible API; get an API key from [Google AI Studio](https://aistudio.google.com/). On the free tier, larger models are often busy (HTTP 503) or slow to respond, so the default is `gemini-3.5-flash-lite`; if you get a 503, wait a moment and click "Get reply" or "Regenerate" |
| Other OpenAI-compatible (most relays) | OpenRouter, DeepSeek, various relays, etc. Enter the API address yourself; it usually ends with `/v1` (for OpenRouter: `https://openrouter.ai/api/v1`) |
| Other Anthropic-compatible (some relays) | Relays that offer Claude's native format |

Click "Fetch list" to get the available model names from the API; then click ▾ at the right of the model box to choose from the list (you can also type a name; the list filters as you type). The fetched list is remembered.

### About the official Claude API

- The latest API version is used. It does not accept the `temperature` parameter, so the Anthropic format has no temperature option and offers "Thinking effort" instead
- Newer Claude models think before writing, so there may be a few seconds' wait at the start, shown as "The model is thinking…"
- For `claude-opus-5-5`, `claude-sonnet-5-5` and similar models, the official automatic fallback is enabled: if a request is blocked by a safety system, the API retries with another model. If it is still refused, a message is shown

### Streamed and non-streamed replies

Replies are always requested as a stream (text appears as it is written). If a relay doesn't support streaming and returns the whole reply at once, it is still read correctly; it just appears all at once when finished.

If you see "The model returned no content", export the log from "Export / Backup…" to see what the API actually returned (for example, some relays put the reply text in the thinking content, which the app can't tell apart).

### If you see "Could not connect to the API"

For security, browsers block some direct requests to external APIs ("CORS restrictions"). The official Claude and OpenAI APIs, Gemini and OpenRouter all allow direct browser access; a few relays don't. **The Windows / macOS / Linux apps don't have this restriction**, so use one of them in that case (the Android app has the same restriction as the web version).

## Project structure

```
index.html        Page structure
css/style.css     Styles
js/i18n.js        Interface languages (Simplified Chinese, Traditional Chinese, English, Japanese) and the default System Prompt
js/db.js          Local storage (the browser's IndexedDB)
js/crypto.js      World card encryption
js/providers.js   Communication with the model APIs
js/render.js      Message display (Markdown/HTML, sandboxed)
js/app.js         Interface logic, conversation management, context assembly
js/vendor/        Third-party libraries (marked: Markdown parser, MIT license, full text in marked.LICENSE.md)
electron/main.js  Entry point of the Windows / macOS / Linux apps (window, security settings, removing CORS restrictions)
android/          Android project (Capacitor); capacitor.config.json is its configuration
assets/           Source images for the Android icon and splash screen
scripts/          Small build scripts (including third-party-notices.js, which checks third-party licenses and generates the notices)
build/icon.png    App icon
package.json      Dependencies, and the packaging configuration for the Windows / macOS / Linux apps
```

The web part is plain HTML/CSS/JavaScript with no build step. The Windows / macOS / Linux apps use [Electron](https://www.electronjs.org/) to package the same pages with the Chromium engine; the Android app uses [Capacitor](https://capacitorjs.com/) to put the same pages into the system WebView.

### Building the native apps yourself

Install [Node.js](https://nodejs.org/) first:

```bash
npm install
npm start            # Run directly (Windows / macOS / Linux app)
npm run dist:win     # Build the Windows version (building on Linux requires wine)
npm run dist:linux   # Build the Linux version
npm run dist:mac     # Build the macOS version (must be run on a Mac)
npm run android:apk  # Build the Android version (requires the Android SDK and JDK 21)
```

The output is in the `dist/` folder.

### Automated builds and releases (GitHub Actions)

`.github/workflows/build.yml` builds the Windows, Linux and macOS versions on GitHub's servers:

- **Publishing a new version**: on the GitHub Releases page click "Draft a new release", create a new tag (e.g. `v0.2.0`), fill in the title and notes and click "Publish release". After about 5 minutes the installers for each system are uploaded to that release automatically, and the download instructions are appended to your notes. The version number comes from the tag, so **there is no need to edit `package.json`**. Pushing a tag from the command line works the same way:

  ```bash
  git tag v0.2.0
  ```

  ```bash
  git push origin v0.2.0
  ```

- **Just checking that it builds**: on the repository's Actions page choose "Build desktop app" → "Run workflow". This builds without publishing; the installers are in the Artifacts at the bottom of that run's page and are kept for 30 days.

The download instructions in a release come from `.github/release-notes.md`. A line saying which commit the installers were built from is added to the end of the release notes automatically; it is also updated when the installers of an existing release are rebuilt from a chosen branch and replaced. That commit is the source code of those installers.

Before each build, the licenses of the third-party components that go into the installers are checked (`scripts/third-party-notices.js`): an unknown license, or one incompatible with AGPL v3, fails the build until it has been reviewed and registered in the script; otherwise `THIRD_PARTY_NOTICES.txt` is generated and included in the installers.

#### Android signing key

Android packages must be signed, **and every future version must be signed with the same key** so users can update in place (otherwise they would have to uninstall first, which also deletes the conversations on their phone). The signing key is kept in the repository's GitHub Secrets (Settings → Secrets and variables → Actions), as two entries:

| Name | Content |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | The signing key file (.jks) as base64 text |
| `ANDROID_KEYSTORE_PASSWORD` | The key password |

The key's **alias must be `proteus`**, and the key password must be the same as the keystore password. If you don't have a key yet, you can create one like this (`keytool` comes with the JDK):

```bash
keytool -genkeypair -v -keystore proteus.jks -alias proteus -keyalg RSA -keysize 2048 -validity 36500
```

If they are not set, build-only runs sign with a temporary debug key instead (installable, but future versions can't update it in place) and show a warning in the run results; runs that publish to a release fail, so a debug build is never shipped to users. Keep a separate safe backup of the key file and password, and **never commit them to the repository**.

#### Android smoke test

Run "Android smoke test" on the Actions page to install and open the app in an Android emulator on GitHub; screenshots and logs are in that run's Artifacts.

## Languages

Until you pick an interface language yourself, the app follows your system language: the Windows / macOS / Linux apps use the operating system's language, the Android app uses the phone's system language, and the web version uses the browser's language. If it is none of Simplified Chinese, Traditional Chinese, English and Japanese, English is used. Once you pick a language in the settings, that choice is kept.

When you switch the interface language, the following change too, not just the interface text:

- The labels sent to the model: `[World Setting]` `[User's Character]` `[Opening]` `[End of Opening]` `[User]` in English (【世界观设定】【用户角色人设】【开场白】【开场白结束】【用户】 in Simplified Chinese, and so on)
- The default System Prompt: if the current conversation's System Prompt hasn't been edited (it is still the default for some language), it is replaced with the new language's default; edited prompts are left alone

The world, character, opening and other content you write yourself are never translated.

## License

This project is open source under [AGPL v3](LICENSE) (GNU Affero General Public License, version 3). Users must provide their own API keys; the developers bear no legal responsibility for what users enter into or receive from this software.

AGPL v3 adds one condition to GPL v3: if you modify this software and let others use it over a network (for example as a website or online service), you must also offer those users the complete source code of your modified version. The project URL at the bottom of the interface is how users get the source code; when offering a modified version, change it (`PROJECT_URL` in `js/i18n.js`) to the address of your modified source code.

Versions released earlier (v0.2.1 and before) were licensed under GPL v3 and remain usable under GPL v3.

Third-party components and their licenses:

- Web part (all versions): [marked](https://github.com/markedjs/marked) (MIT)
- Windows / macOS / Linux apps: [Electron](https://www.electronjs.org/) (MIT) and the Chromium components it includes
- Android app: [Capacitor](https://capacitorjs.com/) (MIT), Apache Cordova, AndroidX, Kotlin, etc. (Apache-2.0)

The full list and license texts are in `THIRD_PARTY_NOTICES.txt` inside the installers: next to the program for the Windows / macOS / Linux apps (together with `LICENSE.txt`, Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html`; on macOS in `Proteus.app/Contents/Resources`), and inside the APK for Android.
