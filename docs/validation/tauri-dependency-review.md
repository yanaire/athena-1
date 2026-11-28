# Tauri dependency and glib review

## Coordinated Tauri upgrade

The four build packages in [PR #12](https://github.com/yanaire/athena/pull/12) include codegen that emits `tauri::image::default_window_icon_from_app_icon_resource()` on Windows. Tauri 2.11.6 lacks that function. The [2.12.7 image module](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.7/crates/tauri/src/image/mod.rs) provides it. Tauri 2.12 also adjusts its `available_monitors` implementation for the runtime's `Result` return type.

The locked desktop stack uses Tauri 2.12.7, runtime 2.12.4, runtime-wry 2.12.5, build/codegen/macros 2.7.6, plugin build tooling 2.7.4 and utils 2.10.4. The application still uses dialog 2.7.3, filesystem 2.5.2 and single-instance 2.4.5. Their Tauri constraints accept 2.12.7. At the time of this review, the native CI jobs covered the locked builds and installed apps on macOS arm64, macOS x86_64 and Windows x64.

RustSec identified `cookie` 0.18.2 and `url` 2.5.8 in the desktop lock. The lock now resolves `cookie` 0.18.3 and `url` 2.5.9. `cargo audit --file src-tauri/Cargo.lock` reported zero Vulnerability records after those updates. The audit still reports `glib` under Unsound and separately lists unmaintained dependencies. See the [cookie advisory](https://rustsec.org/advisories/RUSTSEC-2026-0594.html) and [URL advisory](https://rustsec.org/advisories/RUSTSEC-2026-0592.html).

## Unresolved Linux GTK dependency

The `glib::VariantStrIter` soundness advisory covers `glib >= 0.15.0, < 0.20.0`. The first patched registry version in the advisory is 0.20.0. Dependabot could resolve only 0.18.5. See the [GitHub advisory](https://github.com/advisories/GHSA-wrw7-89jp-8q8g), [upstream fix](https://github.com/gtk-rs/gtk-rs-core/pull/1343) and [failed Dependabot job](https://github.com/yanaire/athena/actions/runs/45597961098/job/139148964726).

`cargo tree --locked -i glib` for `x86_64-unknown-linux-gnu` shows Tauri's `gtk` 0.18.2 and `webkit2gtk` 2.0.2 chain through Tauri, its runtimes, Wry, Tao and Muda. The `glib` requirement from `gtk` is `^0.18`, which also blocks the direct `--precise 0.20.0` resolution on Tauri 2.12.7. The target trees for `aarch64-apple-darwin`, `x86_64-apple-darwin` and `x86_64-pc-windows-msvc` contain no `glib` entry. The alert stays open against the cross-target lock. Linux desktop packaging is outside the supported installer set.

```sh
cargo tree --manifest-path src-tauri/Cargo.toml --locked --target x86_64-unknown-linux-gnu -i glib
cargo tree --manifest-path src-tauri/Cargo.toml --locked --target aarch64-apple-darwin -i glib
cargo tree --manifest-path src-tauri/Cargo.toml --locked --target x86_64-apple-darwin -i glib
cargo tree --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc -i glib
cargo update --manifest-path src-tauri/Cargo.toml --dry-run -p glib --precise 0.20.0
cargo audit --file src-tauri/Cargo.lock
```

Recheck the lock when Tauri and its windowing stack release a coordinated GTK4 migration. If Linux desktop packaging is needed earlier, a separately reviewed upstream backport to the GTK3-compatible `glib` series would need Linux build and runtime testing and ongoing maintenance. See the [Wry migration](https://github.com/tauri-apps/wry/pull/1767) and [Tauri GTK4 tracking issue](https://github.com/tauri-apps/tauri/issues/12563).
