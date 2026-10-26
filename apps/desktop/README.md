# Site Factory desktop

Russian Tauri 2 shell for the explicitly labelled local demonstration. It uses the existing deterministic model and publication adapters; no cloud account, real model, DNS or hosting acceptance is implied.

From the repository root, install the lockfile with `npm ci`, install the pinned Playwright Chromium with `npm exec playwright install chromium`, then run `npm run tauri:dev`. The launcher writes ignored `.local-state/desktop-dev.json` using its own Node executable and this checkout's compiled worker. Rust accepts this trusted configuration only in debug builds. UI requests cannot choose paths, executables, roles, URLs or shell arguments.

The native application stores local state in Tauri's app-local-data directory. An OS file lock permits one controller. A private stdin/stdout pipe carries bounded versioned requests; stderr carries diagnostics. EOF checkpoints active jobs; the native owner waits 15 seconds before terminating the child. On Windows a kill-on-close Job Object owns Node and its Chromium descendants. A dead worker starts again on the next request; interrupted leases remain fenced until their 120-second expiry. Paused jobs resume on application start.

Custom commands are enrolled with `AppManifest::commands` and the `desktop-dispatch` permission is granted only to the local main webview. Generated files are never loaded in that webview. Preview images are read by site/revision/width through private checkpoints and RevisionRepository; no arbitrary file-read command or public screenshot service exists. Interactive preview opens separate sandboxed Chromium with read-only generated files and no native bridge.

Release lookup is fixed to `resource_dir/runtime/node(.exe)`, `runtime/worker/stdio.js`, and `runtime/{templates,references}`. Release resource assembly, bundled browser/runtime installation and signed platform installers belong to packaging Task 14; this task does not claim a self-contained distributable. The dev launch is tested on Windows 10, which is not the approved Windows 11+/macOS 14+ acceptance matrix.

## Checks

- `npm run typecheck`, `npm run build`
- `npm test`: adapter/runtime/protocol tests (real Chromium required)
- `npm run test:e2e`: React in Chromium with a test-only binding to the real stdio worker. This is browser-harness evidence, not native WebView2 acceptance.
- Set `SITE_FACTORY_TEST_NODE` to the absolute trusted Node executable and `CARGO_TARGET_DIR` to a project-local build directory, then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`. Tests cover actual Node lifecycle, request rejection and compiled Tauri ACL dispatch.
