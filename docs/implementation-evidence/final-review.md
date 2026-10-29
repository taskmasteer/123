# Final whole-branch review

BASE `2b2fbefec0f6879fb36bec36c83cd755d1979812` → HEAD `a345580c69fb07d6cb34f0145f28437386f639fe`. **Ready to merge: No.** Spec verdict: not yet conformant; the Important findings below affect required runnable user workflows, safety checks and operational behavior. Quality verdict: substantial durable-state and trust-boundary work, but integration defects and remaining packaging verification gaps require fixes. Counts: **0 Critical, 10 Important, 6 Minor**. External acceptance remains independently open after code fixes.

## Scope and evidence

I read the complete supplied `review-2b2fbef..a345580.diff`, lines 1–44,065, once in bounded chunks, including all commits, source, tests, documentation, configuration and lockfiles. Lockfiles/catalog data were reviewed as dependency and data changes, not as audits of upstream implementations. I read the binding spec, plan, shared context, deferred index, Task14 report/review/rereview and the two Task14 rulings; targeted current-source reads resolved named cross-module and historical questions. No production edits, Git mutation, tests, builds, provider calls or GUI actions were performed in this review. The Task14 report records a frozen verifier (417 unit passes/2 skips, 120 SQL passes/3 skips, package tests, typecheck/build) and a scoped Mac repair; those are reported prior evidence, not tests independently rerun here. Historical default-worker failures remain failures, not relabeled as passes.

Strengths: JWT verification and fresh role lookup are separated from user metadata (`apps/control/src/auth.ts:15`, `:22`); managed job authority fences a lease generation and transfers site ownership into a durable publication reservation (`packages/adapters/src/postgres-queue.ts:178`, `:201`, `:220`). Unknown provider outcomes and cancellation retain reconciliation/exclusion (`packages/adapters/src/postgres-publication.ts:210`, `:233`, `:237`). Retention roots current/draft content and active pins (`packages/adapters/src/retention-sql.ts:50`, `:89`); independent encrypted backup has bounded records and verified hashes (`packages/adapters/src/backup-archive.ts:16`, `:200`, `:285`), with snapshot fencing and fresh authority (`packages/adapters/src/supabase-repository.ts:52`, `:57`, `:145`). Release runtime inventory is bound to an executable-compiled digest (`apps/desktop/src-tauri/build.rs:10`, `:28`, `:30`; `apps/desktop/src-tauri/src/worker.rs:59`). These strengths do not waive the findings or unexecuted acceptance.

## Critical

None found.

## Important

### I1. Managed AI editor is always disabled in the real native client

**Trigger/impact:** Any signed-in managed spec-user or admin opens a site editor, even with a trusted worker and model available. Login installs `RemoteClient` into the shared desktop client (`apps/desktop/src/features/auth/Login.tsx:25`, `:27`; `apps/desktop/src/lib/desktop-client.ts:58`). Its request dispatcher intercepts native `visual.selection.*` and selected `worker.*` operations (`apps/desktop/src/lib/remote-client.ts:250`, `:258`), but does not intercept `device.status` via native model settings: it unconditionally returns `mode: 'blocked'` at `:279–280`. `App.tsx:90`, `:103`, `:175` passes that value to `SiteEditor.tsx:138`; `ChatPanel.tsx:22` disables Send. The required managed AI editing/refinement workflow (`docs/superpowers/specs/2026-10-26-site-factory-design.md:170`, `:256`) is therefore inaccessible through the production Tauri composition.

**Fix/regression:** Derive managed editor readiness from appropriate server/queue capabilities, not the local-device sentinel; queued submission should remain possible when trusted workers are temporarily offline. Preserve local demo/live/blocked behavior and role checks without exposing worker secrets. Exercise the real client composition and UI for managed spec-user and admin, with available and offline workers, including send/refine and local blocked-mode controls.

### I2. A validated first release has no accessible unpublished draft

**Trigger/impact:** Initial generation passes validation but publication is later safely cancelled/terminal before any provider effect, or the site otherwise has a valid draft with no `publishedId`. The worker saves the generated manifest in its checkpoint (`apps/worker/src/pipeline.ts:428–450`), and managed publication builds the initial revision only for settlement (`packages/adapters/src/postgres-publication.ts:151–156`, `:470–476`); the failover fixture confirms a manifest exists while `publishedId` is null (`tests/integration/failover.test.ts:152–156`). Core editing requires `draftId ?? publishedId` (`packages/core/src/editing.ts:393–398`) and `SiteList.tsx:27` shows Edit only when `publishedId` exists, even if `draftId` exists. The approved spec expressly permits editing an unpublished draft (`docs/superpowers/specs/2026-10-26-site-factory-design.md:170`, `:176`).

**Fix/regression:** Preserve an accessible, checked first draft at a safe point, and expose Edit/preview when a valid draft exists without a publication. Preserve automatic first publication and exactly one mutating operation: an unresolved or externally ambiguous publication reservation must continue to block a competing edit until safely reconciled. Test a checked initial release whose reservation is conclusively cancelled before dispatch, a pre-existing draft with null `publishedId`, failure/resume, and an unknown in-flight outcome that must remain fenced.

### I3. Individual cancellation is missing from normal site/editor workflows

**Trigger/impact:** An ordinary user wants to cancel their own unfinished generation or a spec-user wants to cancel an active edit. The only desktop `job.cancel` button is on the admin-only WorkerList (`apps/desktop/src/features/workers/WorkerList.tsx:90`; `apps/desktop/src/App.tsx:154`, `:175`). `SiteList.tsx:27` exposes retry but no cancel; the editor instructs the user to wait or cancel (`apps/desktop/src/features/editor/SiteEditor.tsx:127`) without a cancel action. The managed control route exists and checks authority (`apps/desktop/src/lib/remote-client.ts:338`; `apps/control/src/routes/job-controls.ts:9`, `:19`), but local desktop dispatch/allowlist has no `job.cancel`, and local queue explicitly refuses running cancellation (`packages/adapters/src/sqlite-queue.ts:140–148`). This violates the own-generation role matrix and editor flow (`docs/superpowers/specs/2026-10-26-site-factory-design.md:55`, `:192`).

**Fix/regression:** Provide contextual cancellation on the site/editor, route it through existing fresh role and ownership checks, and support safe local queued/running cancellation with stale-worker fencing. Test own versus assigned/foreign generation, spec-user edit, queued/running states, preserved published content, and an external publication reservation whose outcome is still unknown. Batch cancellation and candidate rejection are separate operations.

### I4. Readability validation misses direct body text

**Trigger/impact:** An otherwise valid page has text directly inside `body`, for example `<body style="font-size:7px;color:white;background:white">Hello</body>`. `apps/worker/src/validation/browser.ts:122–126` tests readable text only in `body *`; `body.innerText` makes the empty check pass, while the body itself never enters the size/contrast check. Since first publication follows validation automatically, an unreadable page can pass. This is the historical Task2 issue and conflicts with the explicit validation requirement (`docs/superpowers/specs/2026-10-26-site-factory-design.md:136`, `:140`).

**Fix/regression:** Evaluate body-owned direct text under the same visibility, size and contrast rules, preserving existing nested-element and empty-page behavior. Use actual bounded browser validation at both required widths with unreadable direct-body text, readable direct-body text and nested controls.

### I5. Automatic topics are fixed labels rather than model-invented subjects

**Trigger/impact:** A row has no `about`. `apps/worker/src/pipeline.ts:124`, `:237–241` deterministically substitutes one of five fixed topics with the domain appended, then passes it as both the about and instruction (`:303–310`; `packages/adapters/src/openai/responses.ts:79`). The model is not asked to invent a separate topic; 100 rows can have at most five subject labels. This misses `docs/superpowers/specs/2026-10-26-site-factory-design.md:11`, `:77` and the plan's separate automatic subject (`docs/superpowers/plans/2026-10-26-site-factory-implementation.md:165–167`).

**Fix/regression:** Make the automatic brief an actual model-invented English IT/crypto topic, while retaining exact user-provided `about` and stable checkpoint/retry behavior. Record the chosen subject before paid subsequent work so crash/resume does not silently change it. Assert automatic versus explicit inputs at the provider boundary and stable subject/seed across a restart; do not claim guaranteed absolute uniqueness.

### I6. Generated/edited content omits the no-invented-facts rules

**Trigger/impact:** A model generates or edits a site. The binding spec forbids fabricated reviews, clients, teams, awards, contacts and success metrics, and requires factual claims to come from inputs (`docs/superpowers/specs/2026-10-26-site-factory-design.md:13`). The shared generation prompt (`apps/worker/src/prompts/generate.ts:3–7`), inherited by edits (`apps/worker/src/prompts/edit.ts:4–6`), does not convey these constraints; static validation does not semantically establish them. Consequently there is no implemented instruction preventing fabricated claims before automatic publication. This is a source gap, not an assertion that a live model was observed hallucinating.

**Fix/regression:** Include the explicit factuality/concept and prohibited-invention rules in both model paths, with bounded checking or review where feasible and without claiming deterministic semantic proof. Test the actual model request for generation and edit, preservation of provided facts, and safe treatment of concept descriptions.

### I7. Batch direction selection has no adjacency or similarity control

**Trigger/impact:** Several adjacent batch rows are generated concurrently. `apps/worker/src/pipeline.ts:232–236` passes local catalog position zero; `packages/adapters/src/local-catalog.ts:46–52` combines that zero with an independent seed, while managed selection independently hashes each job (`apps/worker/src/remote-worker.ts:193–206`). Batch admission retains no diversity decision/position in the generated site input (`packages/adapters/src/local-batches.ts:77–88`; `packages/adapters/src/postgres-batches.ts:71–81`). Adjacent rows can therefore select the same starting style/parameter combination; no simple markup/style similarity assessment is wired. The spec calls for distribution and avoidance of identical adjacent combinations, plus a simple similarity signal (`docs/superpowers/specs/2026-10-26-site-factory-design.md:106`, `:136`).

**Fix/regression:** Persist a bounded, deterministic batch-aware direction decision before dispatch and retries, and provide the specified simple similarity assessment. Respect explicit references, disabled styles and the one-enabled-style fallback; no absolute uniqueness promise. Test adjacent rows through local and managed admission, competing workers and retry/restart, including a measurable repeated-composition case.

### I8. Batch creation lacks pasted-list and manually added-row paths

**Trigger/impact:** A user has a list of domains or wants to add rows without creating a file. The only creation input is the CSV/XLSX file chooser (`apps/desktop/src/features/batches/BatchImport.tsx:27–46`); `BatchDetail.tsx:102` only edits a row already imported. The spec requires paste, CSV/XLSX, and manual row addition (`docs/superpowers/specs/2026-10-26-site-factory-design.md:75`, `:77`).

**Fix/regression:** Add bounded paste/manual entry through the existing staged validation/preview/commit authority, preserving normalization, duplicate/error display, invalid rows and IPC limits. Exercise both entry paths through preview, correction and selective commit, alongside unchanged CSV/XLSX behavior.

### I9. Managed upload requests can hold a job and shutdown indefinitely

**Trigger/impact:** Control prepare/complete or a signed object PUT stalls. All three calls in `apps/worker/src/remote-uploads.ts:25–38` lack timeout and abort signal, unlike ordinary control calls (`apps/worker/src/remote-worker.ts:41–44`). Artifact, validation and checkpoint paths await them (`:157`, `:185`, `:188`). The job heartbeat can continue renewing its lease (`apps/worker/src/pipeline.ts:152–157`), the runner awaits its work (`apps/worker/src/runner.ts:28`, `:45–46`), and stop awaits the runner (`apps/worker/src/managed-runtime.ts:10–14`). A hung transport can occupy a slot/lease and prevent clean stop/failover.

**Fix/regression:** Propagate worker abort and a bounded phase timeout through prepare, each immutable PUT and complete, with cleanup and safe handling of unknown completion; do not blindly retry non-idempotent external effects or weaken immutable capabilities. Use synthetic pending transports for each phase to prove timeout/abort, stop convergence and eventual safe lease recovery.

### I10. Idle clients continuously wake the managed database

**Trigger/impact:** A signed-in panel remains open with no active work. `apps/desktop/src/App.tsx:83–91`, `:133` polls list and session every 600 ms regardless of selected section or activity; the session resolves fresh membership (`apps/control/src/app.ts:138–141`) and the list performs one `repo.current` query per row (`apps/control/src/routes/sites.ts:14`). An open editor adds two requests every 700 ms (`apps/desktop/src/features/editor/SiteEditor.tsx:49–68`). This can keep the database active and multiply idle load, contrary to `docs/superpowers/plans/2026-10-26-site-factory-implementation.md:322`.

**Fix/regression:** Suspend or back off idle polling and keep bounded active-work updates/manual refresh; batch the registry status projection rather than N+1 lookups. Preserve fresh server authorization and timely role revocation on actions. Fake-clock tests should distinguish idle/active cadence, verify revocation handling and bound queries for a full page.

## Minor

### M1. Package manifest lacks source identity (historical Task14 M1)

**Trigger/impact:** A built resource inventory must be traced back to the source used. `scripts/finalize-runtime.mjs:13` records target, signature and lock hashes; `scripts/lib/package-runtime.mjs:38` adds tool versions/inventory, but neither records source revision. The approved packaging preflight explicitly specifies source commit (`.superpowers/sdd/2026-10-26-site-factory-implementation/task-14-design-preflight.md:11`). The independent compiled byte anchor still protects the bytes; it does not identify their source.

**Fix/regression:** Record the actual source revision and truthfully distinguish a dirty build with an explicit fingerprint or reject it. Verify clean/dirty provenance and unchanged manifest-anchor tamper checks.

### M2. Staged vendor dependency resolution is not isolated (historical Task14 M2)

**Trigger/impact:** A required vendor dependency is accidentally absent from a staged runtime. `scripts/lib/package-runtime.mjs:69`, `:79–99` traverses workspace modules but only collects bare package names; `scripts/lib/package-stage.mjs:55–69`, `:93–97` copies a recursive vendor graph without verifying every staged import resolves inside the staged root. Package and extracted-installer smokes (`scripts/package-desktop.mjs:52`; `scripts/inspect-windows-installer.mjs:29`) run under the checkout, where Node may resolve an omitted package in an ancestor `node_modules`. No actually missing dependency was established.

**Fix/regression:** Check staged vendor containment/resolution or run the staged entry in an isolated directory outside checkout ancestors with a scrubbed environment. Deliberately omit a reachable vendor package and require failure; retain platform-specific optional dependency handling and independent clean-machine acceptance.

### M3. Concurrent local import preparation can rewind a committed batch (historical Task10)

**Trigger/impact:** Two direct local `import.prepare` calls for the same upload overlap, and one finishes and commits while the other is still completing. The last transaction unconditionally changes the summary to `preview` (`packages/adapters/src/import-resources.ts:196–220`), unlike the managed state guard (`packages/adapters/src/postgres-import-resources.ts:107–108`). Historical review reproduced the adapter race; serial stdio presently prevents demonstrated concurrent UI reachability. The risk is an adapter caller reverting an active committed batch to preview.

**Fix/regression:** Fence completion against the current state/identity in its final transaction and preserve an already committed batch. Add a direct overlapping-prepare/commit regression with a controlled barrier; preserve exact replay and normal serialized use.

### M4. Empty managed source files fail to open

**Trigger/impact:** An administrator selects a valid zero-byte text file in managed source history. Artifact validation permits empty bytes (`packages/core/src/artifacts.ts:37–38`), and the control route returns an empty base64 string (`apps/control/src/routes/history.ts:50–51`), but `packages/contracts/src/recovery-wire.ts:40–46` calls the nonempty `string` validator (`packages/contracts/src/http.ts:14`). `RemoteClient` validates this response (`apps/desktop/src/lib/remote-client.ts:60`, `:391`), so `SourceFiles.tsx:34–42` reports an error; even after accepting the value, its `text ||` loading fallback (`:90`) needs an explicit empty state.

**Fix/regression:** Accept canonical empty base64 only for a consistent zero-length/EOF response and render a completed empty file. Test managed zero-byte file, EOF, ordinary chunk and malformed/truncated response. The separate native archive download path was not assessed as broken by this finding.

### M5. Stale managed-mode and onboarding copy contradicts configured capability

**Trigger/impact:** A user sees the login, worker, model settings, create-site or chat screen in a configured managed installation. `Login.tsx:47` says generation/publication are unavailable; `WorkerList.tsx:92` and `ModelSettings.tsx:47` say hosting is not connected; `CreateSiteDialog.tsx:17` promises a local version; `ChatPanel.tsx:13` says history is stored on-device. These statements can be false despite server capabilities and managed persistence. Root `README.md:25` also describes earlier local JSON behavior.

**Fix/regression:** Use current capability-aware or neutral copy and update the README to describe the current modes and persistence. Check both configured/unconfigured managed and local copy without claiming unverified live service health.

### M6. Registry omits the site topic and last error

**Trigger/impact:** A user scans the site registry to understand a generated or failed site. The spec requires the table to show each site's topic and latest error (`docs/superpowers/specs/2026-10-26-site-factory-design.md:73`), but `apps/desktop/src/features/sites/SiteList.tsx:26–27` renders neither. The managed list's `jobView` also omits a per-site error (`apps/control/src/routes/sites.ts:14`; `packages/contracts/src/http.ts:9`); the global refresh/action alerts in `apps/desktop/src/App.tsx:172–174` are not a persisted per-site failure. Users cannot identify the subject or diagnose a failed row from the registry.

**Fix/regression:** Add a bounded, authorized topic and safe, classified latest-error projection to local and managed registry rows, coordinating the persisted automatic topic with I5; do not expose raw provider responses, secrets or private checkpoint contents. Test manual and automatic topics, a failed site with a safe diagnostic, clearing or replacing stale errors on retry, and scope/secret filtering.
## Historical item dispositions

- **Task1:** Corrupt-state test now reaches an invalid nested site (`packages/adapters/test/local-state.test.ts:88`); duplicate identities are rejected in `packages/adapters/src/local-state.ts:49–63`, although a dedicated duplicate legacy fixture remains absent. No current duplicate-state bug established. Junction aliases are rejected by `packages/adapters/src/safe-files.ts:23` and covered at `packages/adapters/test/local-database.test.ts:67`. Disposition: source issue resolved; duplicate fixture is a coverage limitation, not a separate finding.
- **Task2:** Still open and promoted to I4.
- **Task4:** Russian plural selection is implemented (`apps/desktop/src/lib/labels.ts:1`); first-load failure remains distinguishable from empty (`apps/desktop/src/App.tsx:183`). Disposition: resolved.
- **Task5:** Refinement relationship is surfaced from `parentRevisionId` (`apps/desktop/src/features/editor/SiteEditor.tsx:46`, `:126`); chat refinement action remains at `:131`. Disposition: resolved; managed readiness is separately I1.
- **Task7:** Some SQL/DTO modules remain compressed, but a size-only maintainability complaint is not a demonstrated actionable defect. Disposition: no separate finding. Viewport evidence, not stitched full-page screenshot, is the supported visual observation; no native-layout conclusion inferred.
- **Task8:** Worker stage/state labels are mapped (`apps/desktop/src/lib/labels.ts:2–3`; `WorkerList.tsx:90`). Expiry contender lock wait is observed, while the revocation half of `tests/integration/failover.test.ts:218–252` starts a checkpoint and revokes without an observed contender barrier. It proves rejection after revocation, not an overlapping lock wait. Disposition: labels resolved; concurrency evidence limitation remains, not a proven source defect.
- **Task9:** Safe classified diagnostic projection is allowlisted (`packages/adapters/src/postgres-publication.ts:198`, `:425–450`) while reservations remain fenced. Disposition: resolved.
- **Task10:** Open adapter race, M3; stdio serialization limits demonstrated reachability.
- **Tasks6–12 and Task13/15 M2:** Task14 report records launcher color normalization and lazy chunks below the unchanged 500 kB warning threshold; source has narrow `scripts/test-e2e.mjs:2–5` handling. LF/CRLF notices and old failures remain historical facts, not hidden fixes. No new full build run here.
- **Task13 M1:** Same-revision/new-outcome stale read/completion and subsequent due claim are tested at `tests/integration/health.test.ts:35–43`. Resolved in source; prior Task13 raw capacity JSON overwrite is documented in `task-14-report.md:85–89`, with quoted historical results and preserved separate closure evidence, not a new independent run.
- **Task15 M1:** Checkpoint state body read detector uses actual SHA-bound GET observation and a deliberate positive control (`tests/integration/backup.test.ts:192–223`). Resolved in source; no extra capacity run claimed.
- **Task14 I1:** Scoped rereview reports the short private Mac ownership socket repair clean at `8768d2d`; current `apps/desktop/runtime-guard/src/owner_socket.rs:12`, `:89–104` uses a private fixed root and owned nonrecursive cleanup. This is source/component evidence, not actual Mac14 execution. Task14 M1/M2 remain M1/M2 above.

## Declined to judge

- **Actual live pilot automation versus execution:** The plan names `--live` and requires explicitly configured connections/domains (`docs/superpowers/plans/2026-10-26-site-factory-implementation.md:329`) and separately requires a real 5–10-site, two-device, visual and restore exercise (`:335–341`); the spec describes outcome scenarios (`docs/superpowers/specs/2026-10-26-site-factory-design.md:244–264`) without requiring the CLI to automate each physical/user action. Current `scripts/pilot.mjs:6–13` checks supplied configuration syntax and prints `live-preflight`; `docs/pilot-report.md:22` and `task-14-report.md:71` disclose that it executes no live pilot. I do not treat the preflight as proof of configured service connectivity or a completed pilot, nor infer a separate missing orchestrator solely from the plan. The runnable product gaps are findings I1–I10 and remain independently actionable.
- **Semantic visual quality/model factuality:** No live model or user visual approval was available; the missing instructions are I6, but static inspection cannot establish the factual truth or aesthetic quality of future model outputs.
- **Unobserved concurrency and platform behavior:** Absence of an observed Task8 revocation barrier, staged dependency omission, or physical Mac execution is not presented as proof of an actual violation. The concrete verification improvement is M2; the rest is evidence limitation.
- **Cross-adapter restore:** Same-adapter independent encrypted backup is the approved v1 boundary; cross-adapter migration is separate. No security or upstream dependency audit is implied by reading lockfile entries.

## CannotVerify and owners

1. **Windows owner:** clean Windows 11 with WebView2, actual native UI/choosers/credential store, lifecycle, crash/descendant cleanup and installation without Node/npm. Windows 10 component evidence/headless smoke is not this acceptance.
2. **Mac platform owner:** actual macOS 14 arm64 and x64 link/package/install/native UI, socket/FD/process-group and parent-crash cleanup; cross-target compile and pure tests are not execution. **Release owner:** signing, notarization and distribution decisions.
3. **Authorized account/service owner:** real configured Supabase Auth/invitations/refresh, R2 private signed conditional upload, Vercel/OpenAI, DNS/custom HTTPS, 5–10 personal noncommercial demo sites and real billing/usage. These actions require their own explicit authorized environment; no credentials or provider calls were used here.
4. **Platform/operator owner:** two physical trusted devices and checkpoint failover, including stale-worker fencing under real disconnect; synthetic SQL/logical-worker fixtures do not prove the physical scenario.
5. **User/design owner:** visual assessment of five directions and actual desktop/mobile sites. Fixture screenshot dimensions/viewport evidence are documented, not user approval.
6. **Performance/backup owner:** real 13.5 GB projected bodies, maximum 48 GiB encrypted archive and full end-to-end resource/disk envelope. Task14 records 940,009 metadata records and 270,000 descriptors with 222,187,605 bytes of small bodies after trusted extraction, not full-body/cipher throughput; the recorded 44.4 s commit does not prove a universal sub-15 s envelope. Disk measurements are samples, not a continuous minimum/peak.

Ready to merge remains **No** until the runnable Important defects are fixed and independently rereviewed; external acceptance should be reported separately and completed by its named owners before claiming full pilot/platform readiness.