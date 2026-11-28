# Installation from source

GitHub Actions verifies desktop builds on **Apple Silicon macOS** and **Windows x64**. The Intel Mac target is available for manual builds. The [Korean installation guide](installation.ko.md) includes the platform-specific commands.

| Build computer | Rust target | Build command | Output |
| --- | --- | --- | --- |
| Apple Silicon Mac, macOS 13.5+ | `aarch64-apple-darwin` | `npm run desktop:build` | `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Athena.app` |
| Intel Mac, macOS 13.5+ | `x86_64-apple-darwin` | `npm run desktop:build:mac-intel` | `src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Athena.app` |
| Windows 10/11 x64 | `x86_64-pc-windows-msvc` | `npm run desktop:build:windows` | `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe` |

`npm run desktop:build` selects the native architecture on all three computers. The explicit commands verify the host architecture and reject cross-compilation. Windows ARM64, 32-bit Windows, Linux desktop packaging and a universal macOS binary are outside this candidate. Linux can still run the browser host and analysis tests.

These are developer builds. The Mac application is locally sealed ad hoc; the Windows installer is not Authenticode signed. No official signed/notarized download or public release is produced by these commands or CI. Existing [release gates](release-checklist.md) remain separate from source build verification.

Install the tools listed in [development](development.md), then from a clean checkout of the candidate run:

```sh
npm ci --ignore-scripts --no-audit --no-fund
python3 athena-backend-handoff/athena-codex-ui/build.py
npm run analysis:prepare
npm run desktop:build
```

On Windows, `python` may replace `python3` if that is the installed executable. Use PowerShell or a Developer PowerShell for Visual Studio. The npm build commands do not rely on POSIX shell variable assignments. Building needs Node **24.22.3**, Rust **1.99.1**, Python 3, and the platform compiler toolchain. See the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for Xcode Command Line Tools on macOS or Visual Studio **Desktop development with C++**, the Windows SDK and WebView2 on Windows.

## Windows installation

Windows builds and installed applications require [.NET Framework 4.8 or later](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-10). Windows 10 version 1903 and later include 4.8; Windows 11 includes 4.8 or 4.8.1. This system runtime runs Athena's small file-permission helper. `npm run windows:prepare` compiles the authored helper with the fixed Windows Framework compiler; the desktop build bundles the result. Source `npm start`, `npm test` and `npm run analysis:prepare` run this preparation automatically. The installed application never compiles a helper at startup.

The NSIS installer checks the framework before WebView2 and Athena payload installation. A missing or older framework stops installation with an explanatory message; silent (`/S`) installation exits with code `2` without a dialog. It does not download or install the framework itself.

Build on Windows x64 with `npm run desktop:build:windows`, then open the generated `Athena_…_x64-setup.exe` under `bundle/nsis`. The NSIS installer supports English and Korean and installs for the current user. If WebView2 is absent or below **101.0.1210.39**, the installer requests a runtime installation or update and needs an internet connection. Use the current Microsoft WebView2 Evergreen runtime when launching a source-built executable directly. The installed app includes Node, host dependencies and the WASI analysis runtimes. Configure a model provider separately. The minimum WebView2 version comes from [Wry's private browsing mode](https://docs.rs/wry/0.57.4/wry/struct.WebViewBuilder.html#method.with_incognito).

Use supported API credentials or a compatible endpoint with the standard installer. For ChatGPT plan sign-in, build the personal local variant described below. The Windows CI job installs NSIS into a fresh disposable directory, verifies the installed runtime, starts the desktop with WebView2, quits it and runs the uninstaller. Publisher signing, SmartScreen and real-account acceptance on a user's PC have separate release checks.

## Manual Intel Mac installation

Use native **x64 Node** on the Intel Mac and install the `x86_64-apple-darwin` Rust target. Run `npm run desktop:build:mac-intel`; the resulting `.app` contains Intel versions of the application, Node and the analysis helper. Copy the complete `Athena.app` to the desired Applications directory. An Apple Silicon `.app` is not the Intel build, and this candidate does not require Rosetta on an Intel Mac.

On either Mac architecture, run `node scripts/check-macos-dmg.mjs` after `npm run desktop:build` to create a DMG under the target's `release/bundle/dmg` directory. The script verifies the image, copies the app from its read-only mount, then verifies and starts that copy with a temporary workspace. The local app has an ad hoc seal. Developer ID signing, Apple notarization and Gatekeeper distribution checks remain part of the release process. See [model providers](model-providers.md) to connect a supported model.

The Apple Silicon and Windows x64 CI jobs record package names and SHA-256 digests in their logs. The verification images and installers stay on the runner.

## Personal local build with ChatGPT

For personal local use, developers can run `npm run desktop:build:local-chatgpt` instead of `npm run desktop:build` on a supported native build computer. It writes to the same target's build output path with a separate app identifier, so preserve the previous build before switching variants. macOS bundles are sealed ad hoc. The standard desktop build and browser host leave ChatGPT sign-in disabled. The route's actual account eligibility and native browser callback must be accepted separately on each platform.

In the personal app, select **Settings → Models & connections → Continue with ChatGPT → Open in system browser**. Approve it in the official OpenAI page. Athena receives the callback automatically; no API key or copied authorization code is needed. Select a model from the connected account's catalog and save a profile. OpenAI's [official implementation guide](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt#usage-policy-and-terms) covers personal projects that run locally and requires a separate access request for paid or remotely hosted apps. Account and workspace eligibility still apply.

To check which Mac app you opened, run this against its actual bundle path:

```sh
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "/path/to/Athena.app/Contents/Info.plist"
```

The personal build reports `com.athena.desktop.local-chatgpt`. After sign-in, check **OpenAI connection** in Settings. If the selected registration says **plan usage disabled**, use **Enable ChatGPT plan usage** and review the grant in the system browser. With plan usage enabled, choose a model from **ChatGPT account catalog**, save the profile, and click **Verify**. Streaming and tool calling have separate results. To check delegation, select the profile for a conversation and ask the parent to have one worker return a short phrase. Quit and reopen the app to check the saved profile again.

## Browser development

For browser development with a compatible local model server, use this command on macOS or Linux:

```sh
ATHENA_ENDPOINT=http://127.0.0.1:8080/v1 ATHENA_MODEL=athena-local npm start
```

In Windows PowerShell:

```powershell
$env:ATHENA_ENDPOINT = 'http://127.0.0.1:8080/v1'
$env:ATHENA_MODEL = 'athena-local'
npm start
```

Use your model's actual slug, then open `http://127.0.0.1:4317` locally. Prepare the analysis runtime first if needed. Docker-free analysis is disabled by default for each project.

Use an isolated `ATHENA_DATA_DIR` and synthetic credentials for testing. [Credential security](keychain-security.md) covers the default local store and optional macOS Keychain import. A source build or clean CI installation does not establish installation, signing or upgrade behavior on another user's computer; that verification belongs to the desktop release.

If the previous vault cannot be imported, leave it untouched and connect the provider in Settings. Do not put passwords, tokens or private research data in test reports. See [privacy](../PRIVACY.md) and [known limitations](known-limitations.md).
