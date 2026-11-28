# Development

This document describes a local source build. The cross-platform candidate supports native macOS arm64, macOS x64 and Windows x64 packaging. Developer ID signing, notarization, Windows Authenticode signing and acceptance on another user's computer remain desktop-release work. No virtual machine is required to build on the matching operating system.

Builds use Node 24.22.3, npm, Python 3 for UI assembly, and Rust 1.99.1. macOS needs Xcode Command Line Tools, `curl`, `tar` and `unzip`; Windows needs the MSVC C++ build tools/Windows SDK, .NET Framework 4.8 or later, WebView2, Windows PowerShell, `curl.exe` and `tar.exe`. The native targets are `aarch64-apple-darwin`, `x86_64-apple-darwin`, and `x86_64-pc-windows-msvc`. npm and both Cargo graphs use lockfiles. Upstream Node and WASI archives are checksum pinned. The [workflow](../.github/workflows/verify.yml) verifies the Apple Silicon and Windows x64 desktops and the Chromium UI without Docker. Intel Mac builds can be checked locally with the same native toolchain.

```sh
npm ci --ignore-scripts --no-audit --no-fund
python3 athena-backend-handoff/athena-codex-ui/build.py
npm run check
npm run analysis:prepare
npm test
npm run desktop:build
```

Regenerate with `python3 athena-backend-handoff/athena-codex-ui/build.py`. The [UI contract commands](../athena-backend-handoff/START-HERE.md#기존-ui-확인-명령) run independently of Finder and real-model testing. Desktop preparation consumes the generated HTML. Keep local workspaces, credentials, bundled apps and raw QA evidence out of Git.

`npm run windows:prepare` builds the Windows permission helper from the repository's C# source using the fixed system .NET Framework compiler. It is a no-op on other platforms. The `start`, `test` and `analysis:prepare` npm commands include this preparation; when invoking Windows tests directly with `node --test`, run `npm run windows:prepare` first. Desktop staging copies the helper and its fixed configuration into the host payload and records their hashes. The installed host uses that prepared helper without compiling code or falling back to per-read PowerShell startup.

## Manual task recovery

The host advertises `retry_task` for failed, interrupted (`paused`), or cancelled direct child tasks from the latest run in the selected conversation. The workflow detail and conversation activity show the host's eligibility and failure reason. A retry stays in the original run and task, appends an attempt, and retains prior attempts, logs, successful sibling results, and artifact versions.

The RPC is `retryTask(taskId, { requestId, expectedAttemptId })`. Reuse the request ID after an uncertain response; the UI saves its request identity before sending it. The host atomically records the child attempt, a coordinator reconciliation attempt, and a durable receipt. Replaying a receipt returns that acceptance without dispatching work again. A mismatched payload, stale attempt, older run, or different selected conversation is rejected. A later cancellation during retry preparation also prevents admission. Previously settled prompt receipts retain their original outcome.

Recovery rechecks the original input bytes and artifact grants. Saved model profiles retain their original model, thinking level, endpoint, and account target; changing the project default does not retarget a retry. If that context is unavailable, recovery reports an error before accepting a new attempt. Legacy endpoint configuration is checked against the original runtime model; older legacy records without an endpoint can only validate their saved provider, model, and thinking level. Restarted hosts pause unfinished work and require another explicit retry request; restoring history or replaying an accepted request never resumes execution automatically.

Saved API-key profiles also bind the resolved credential to the run. A private, installation-scoped HMAC key makes this binding stable across restarts without putting the API key in model metadata. Replacing the credential prevents an old run from being retried with the replacement; a new request can use the new credential. Old API-key runs that saved only a provider-wide authentication label cannot prove which credential they used and must start a new request after restart. Losing the private binding key also requires a new request. ChatGPT continues to use its existing registration identity. In-memory providers without a storage directory only preserve the binding for the same credential-store instance. Legacy environment-only sessions using `ATHENA_ENDPOINT`/`ATHENA_API_KEY` do not pass through profile credential binding; their recovery checks remain limited to the saved model and endpoint. Use a saved model profile when recovery must retain the original credential.

After the children settle, the coordinator gets a new turn to update the final answer from their current results. This context uses a persistent hidden SDK custom message, so internal task identifiers do not become a visible user message. Real user messages remain unchanged, even when their text resembles a recovery prompt. During recovery the host permits result inspection and joining, and rejects coordinator requests to spawn, send more work, or cancel children. The scheduler keeps one lease per Pi conversation so an earlier parent turn cannot overlap this continuation. Successful siblings are not reexecuted.

Each attempt stops after three failures for the same tool and equivalent arguments, or eight total tool failures. A successful call clears the repeated-failure count only for its own argument signature. The total failure count remains for the attempt. The host persists a failed outcome before aborting Pi, so a later aborted event cannot replace the recorded cause. A user-approved new attempt gets a fresh budget; existing artifacts and logs remain available.

Host-added attachment instructions remain in the model dispatch and saved Pi transcript. Live user messages and public history show the original user input by matching the exact owning attempt and appended attachment metadata. Text that the user independently writes, including a literal copy of those instructions, remains unchanged. This projection does not change file grants or stored transcripts.

Tool activity cards show each recorded tool call's own outcome. Retrying its task does not change a previously completed tool into a running or failed tool, and the earlier logs and result links remain attached to that call. Moving between a conversation with results and an empty conversation invalidates both artifact render caches: the empty conversation cannot retain another conversation's result, and reopening the original conversation restores its table and download.

Process completion and artifact publication must be stored before a successful result is returned to the model. A publication failure returns a failed result without an artifact. If even the failure cannot be recorded, the runner stops admitting work and settles queued requests instead of reporting unrecorded successes. A notification listener failing after the storage transaction commits does not undo the stored publication.

Focused regression checks use real Pi sessions with a controlled loopback provider, durable SQLite state, actual CSV jobs, and forced process death:

```sh
node --test tests/manager-recovery.test.ts tests/recovery-http.test.ts tests/tool-failure-budget.test.ts
```

The complete workflow also prepares the WASI runtime, runs the host and UI checks, and builds the native application on Apple Silicon and Windows x64 runners. Windows additionally installs the generated NSIS package in a disposable CI directory, verifies its installed runtime, and requires the uninstaller to remove its installed executables and host resources. This does not assert removal of registry entries, shortcuts or external workspaces. Controlled-provider and DOM checks do not establish real-model quality, native WebView rendering or a user's operating-system installation experience.

## Distribution review builds

For a distribution review build, start in a clean source directory and run the desktop build with the path mappings below. Both Rust executables otherwise can contain the build account's home path in compiled source locations. Cargo passes each mapping as a single argument even if its path contains spaces. Use a clean shell for this recipe; it supplies the build's Rust flags.

```sh
(
  umask 022
  root=$(pwd -P)
  CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$HOME=/build/home$(printf '\037')--remap-path-prefix=$root=/build/athena" npm run desktop:build
)
```

Keep the enclosing work directory private (`0700`), but allow read and traversal permissions on the distributable files at build time. A `077` build umask made the first remapped review app inaccessible to other users. Check the final ZIP's modes as well as its entry names and uncompressed contents for the original home and build directory prefixes. The remapped review build does not change previously archived candidates.

The local bundle check signs the WASI helper with Hardened Runtime and no entitlements, then exercises both guests through the bundled Node host. The helper uses Wasmtime's Pulley interpreter. The local Node executable retains its upstream signature. When preparing a Developer ID build, verify each nested executable separately: re-signing Node under Hardened Runtime without `com.apple.security.cs.allow-jit` prevents V8 from starting. Grant JIT only to Node; do not apply a bundle-wide entitlement file. Tauri CLI 2.12.6 uses the same configured entitlement file for every signing target, so a release with per-executable entitlements needs a separate signing step before notarization.

The bundled Pi TUI ARM64 `darwin-platform.node` prebuild has an ad-hoc signature. A JIT-only hardened Node test copy could start but could not load that module. For release, sign the native module with the app's Developer ID team before sealing the app, and verify it loads with library validation still enabled. This same-team path requires a Developer ID acceptance run. Check both WASI guests and the app after signing and before submitting for notarization. See the [release checklist](release-checklist.md).

To test an existing trusted bundle without re-signing it, run `node scripts/check-desktop-bundle.mjs --verify-only "/path/to/Athena.app"` from a reviewed source checkout matching the bundle's build revision. Keep the checker with `scripts/desktop-platform.mjs`, `scripts/analysis-provenance.mjs` and `sandbox/Cargo.lock`: the verifier imports those helpers and compares the bundled sandbox identity with that lock. The original build output directory is not required. If Node is not installed separately, use the app's own Node with the matching source checkout:

```sh
athena_app="/path/to/Athena.app"
athena_source="/path/to/reviewed-athena"
"$athena_app/Contents/MacOS/athena-node" "$athena_source/scripts/check-desktop-bundle.mjs" --verify-only "$athena_app"
```

Use only a bundle the Mac already permits you to run. The checker verifies the seal and bundled WASM digests and runs Python and QuickJS in a disposable workspace. After saving a profile with a generated credential, it closes the bundled Node host's startup pipe before delivering the vault key. It checks that startup fails without a readiness frame and that the vault bytes and `0600` mode survive. An authenticated restart then verifies the saved profile, streaming, and tool calls against a loopback fixture. The checker does not launch Finder or test the login Keychain.

Run `node scripts/check-desktop-bundle.mjs --pre-notarization "/path/to/Athena.app"` on an already signed candidate before submitting it. This checks Developer ID signatures, the signing team, Hardened Runtime, entitlements, and the ARM64 Pi module before running the same functional checks. It does not sign, submit, or staple the app. After notarization and stapling, run the command with `--release` instead, on a Mac with the Apple command line tools. This also checks the stapled ticket and Gatekeeper before executing bundled code. Only then run the [clean Mac acceptance](installation.md).
