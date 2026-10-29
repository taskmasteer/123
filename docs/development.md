# Development and local packages

Use exact Node24.21.0, the locked npm dependencies, Rust/MSVC on Windows or Xcode tools on macOS, and PostgreSQL18 for the disposable SQL tests. Supported acceptance hosts are Windows11 x64 with WebView2 and macOS14+ arm64/x64. A Windows10 build is component evidence only. The workflow uses explicitly provisioned matching self-hosted runners; adding its YAML does not mean those hosts ran.

From the repository root:

```powershell
npm ci --ignore-scripts
node scripts/prepare-browser.mjs --target win32-x64
$env:PLAYWRIGHT_BROWSERS_PATH = (Join-Path (Get-Location) '.local-state/package/win32-x64/runtime/browsers')
npm run verify
npm run pilot -- --fixtures
npm run package:desktop -- --target win32-x64
```

`verify` runs type checking, all unit cases with one file worker, package boundary tests, the complete disposable PostgreSQL integration suite, TypeScript emission and Vite. The unit budget preserves the original timeouts and explicit concurrent operations inside each test; it does not reclassify earlier default-worker failures. SQL setup owns a random test directory, random local port and generated fixture password. It never adopts a running database. Use direct `node scripts/test-integration.mjs ... -t '^(?!.*actual900009)'` for a bounded focused rerun on Windows: npm.cmd/cmd can consume the caret. The unfiltered final verify intentionally includes the large metadata fixture once.

Fixture pilot uses the real worker, synthetic model/object/publication adapters and headless Chromium. It records five visual directions, manual/automatic subjects, desktop/mobile image dimensions and screenshots, scoped usage, edit/visual/recovery cases and SQL failover/restore cases under `.local-state/pilot`. Synthetic usage and two logical workers do not measure provider billing or two physical devices. `--live --config C:/explicit/pilot.json` is an account/domain preflight only: require `personalNoncommercial:true`,5–10 unique `demoDomains`, and explicit `accounts` strings for `controlOrigin`, `supabaseProject`, `r2Bucket`, `vercelAccount`, `openaiProject`. The control origin must be HTTPS. There is no credential discovery or automatic account, DNS, publication or paid-plan action. Actual authorized live execution and user visual assessment remain a separate acceptance run.

## Runtime resources and integrity

Targets are `win32-x64`, `darwin-arm64` and `darwin-x64`. Prepare and inspect archives on any host; build and run a package on its matching host:

```powershell
node scripts/prepare-runtime.mjs --target win32-x64 --offline
node scripts/prepare-browser.mjs --target win32-x64 --offline
node scripts/check-source-archives.mjs --target darwin-arm64 --offline
npm run package:desktop -- --target win32-x64 --offline
```

The committed source lock fixes exact official URLs and expected archive digests. Node digests came from its official HTTPS SHASUMS256.txt. Browser digests were recorded from the exact Playwright1.64.1 metadata and controlled official HTTPS retrieval, including redirects; they are not published upstream signatures. Once locked, missing/offline/changed archives fail closed. `--record-source` is the explicit maintainer recording step; review a lock change before distribution. Normal client startup never downloads a runtime or resolves a system Node/browser.

The Task14 host later retired only its newly downloaded compressed archives and duplicate staged tree under explicit disk rulings, after preserving all source hashes/provenance and inspection proof. Its usable release/runtime and final installer remain. Repeating an offline preparation therefore requires first retrieving the exact locked archives again through the ordinary online preparation command; cache absence is a deliberate error, not a reason to substitute system binaries.

Resources preserve `runtime/apps/worker/src/stdio.js`, `runtime/packages/*/src`, an ESM package root, complete locked production vendor packages, Node binary/license, five templates,14 references and full Chromium/headless1248/ffmpeg1013 distributions (plus winldd1007 on Windows). Workspace import analysis rejects unresolved and nonliteral imports. Vendor packages are copied whole according to locked dependencies and target-compatible optional dependencies, rather than interpreting unrelated optional Electron/dev references in bundled vendor source. Profiles and restored schema9/catalog data remain in private application data; restored data never becomes executable resources.

The final manifest inventories exact paths, hashes, sizes, links and executable modes. The finalized manifest SHA256, target and format are compiled into the main native executable. `check-package.mjs --root ... --expected-manifest-sha256 ... --target ...` requires an independent expected digest, normally the trusted build receipt. Editing a resource and adjacent manifest does not re-anchor the native executable. Replacing the unsigned main executable itself is outside this integrity guarantee. Actual publisher signing/notarization remains required for a distributable release.

Resource helpers are finalized before the manifest, and the main executable remains outside its inventory. Mac local packaging ad-hoc signs the fixed ownership helper before hashing it, preserves official runtime/browser bytes, then builds the anchored main and outer app. It clears ambient Apple signing/notarization variables and makes no credential discovery. The pinned Tauri2.12.2 signing path does not deep re-sign Resources; a post-bundle full inventory check catches resource mutation. Any future publisher signing must finalize every changed resource first, regenerate the manifest, rebuild the main anchor, sign main/outer bundle without changing resource bytes, then verify again. Ad-hoc local signatures do not establish publisher identity or notarization. [Tauri signing](https://v2.tauri.app/distribute/sign/macos/), [pinned bundler source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-bundler/src/bundle/macos/app.rs).

Release launch fixes NODE_ENV=production and a resource-derived browser root. Private native bootstrap grants persistence only after process containment. Its process-local permit brands the actual SQLite handle; environment/renderer/config/archive values cannot grant that scope, and ordinary demonstration handles remain denied in production. Verified independent restore carries the handle scope in memory, never serialized into an archive. Enrollment/model capability rules remain separate.

Windows attaches a kill-on-close Job before releasing the bootstrap grant. Mac uses the fixed private watchdog/proxy/anchor helper, authenticated owner-only IPC and preserved Playwright descriptors1/2/3/4/default arguments/sandbox. It retains each owned direct anchor until cleanup before reaping, so group signals cannot target a reused PID. Proxy failure and watchdog/parent EOF both clean the real browser group. No public arbitrary PID/executable/profile broker exists. Missing/corrupt resources give recoverable Russian repair guidance without silently launching an unenrolled managed worker.

## Native diagnostics, installer inspection and disk

The main binary accepts `--package-info` and `--package-smoke` before Tauri initialization. These fixed diagnostics accept no paths or credentials. Smoke uses a fresh temporary root and memory-only secrets, explicitly selects synthetic demo generation, checks headless browser work and restart persistence, and verifies unenrolled managed access stays blocked. Capture the GUI-subsystem executable through a waiting process API; a bare PowerShell invocation may return before it finishes. These modes do not inspect native windows, WebView2, choosers or OS credential stores.

The Windows build includes the WebView2 offline installer. The generated installer is never executed by the inspection script. `node scripts/inspect-windows-installer.mjs --installer <generated-setup.exe>` verifies the pinned isolated official-source7zz CLI, lists and bounds NSIS entries, extracts one controlled tree, checks the actual native executable/resource bytes and compiled anchor, then runs only early no-GUI diagnostics. It tests missing browser, resource-plus-manifest replacement and exact repair. Portable main must match its trusted build receipt; installed main must match the complete expected bytes after the pinned Tauri2.12.2 first bundle-type marker UNK→NSS transformation. Both full hashes are recorded separately, without an arbitrary-difference allowance. Installer installation/ACL/WebView2 behavior on a clean Windows11 machine remains pending.

The inspector's official source archives, bootstrap tools, local MSVC recipe and measured binary digest are in `scripts/package-tools.lock.json`. The standalone7za variant lacks NSIS, so Alone2/7zz was compiled from that verified source in `.local-state/package-tools`; it is not installed globally. A different compiler output requires a reviewed expected digest update. Archive provenance is controlled HTTPS and a committed expected digest, without a claimed upstream signature.

All Cargo commands must set checkout-local `CARGO_TARGET_DIR`, trusted `SITE_FACTORY_TEST_NODE`, `CARGO_INCREMENTAL=0`, dev/test/release debug symbols0 and a bounded job count. Packaging sets these explicitly. Never use or delete an inherited external Cargo cache. Keep a2GiB free floor, retained preparation≤2GiB, native growth≤3GiB and installer plus one extraction≤1.5GiB; measure the actual next writes and temporary peak serially. Warm Node preparation validates the complete archive but materializes only shipped binary+LICENSE, reusing unchanged verified bytes. Keep caches and current binaries. Windows NSIS uses a read-only8.3 source alias only after realpath and full manifest comparison, preserving relative destinations and all inventory bytes.

Full SQL verification needs its own budget after package outputs are retained. The initial3GiB working estimate was insufficient as a blanket reservation: the observed run needed retirement of723167042B of new Mac archives during preparation. Its sampled free minimum was2380091392B after that retirement; sampling is not a measured peak or continuous free-space trace. The Windows archive retirement occurred after commit cleanup, so it did not demonstrate avoidance of the commit floor. Plan conservatively for at least8GiB free before a fresh full gate (5GiB working,2GiB floor,1GiB contingency), remeasure and monitor actual phases; this recommendation is a planning margin, not a proven maximum. Retiring owned regenerable Task14 outputs under exact rulings did not delete pre-task caches, user data or current app binaries. No general cache-cleaning command is provided.

Set `SITE_FACTORY_TEST_EVIDENCE_PREFIX` to a unique run label when preserving local capacity history. Both transport and retention-capacity fixtures honor it; retention retains its legacy task13 default for compatibility. The Task14 full gate used `task14-final-20261029`. A post-gate filename-only refinement added retention to this convention; the full capacity case was not repeated just to rename reports.

See [pilot evidence](pilot-report.md) for actual results and outstanding platform/provider acceptance.
