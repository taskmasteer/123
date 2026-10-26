# Task 1 implementation report

Status: DONE. Implementer scope only; no subagents were used.

## Scope delivered

- Root npm workspace with pinned development dependencies and lockfile; contracts,
  core, adapters and testing are private workspace packages. Node 24 ESM TypeScript
  build, full test command, targeted file selection and typecheck are runnable.
- Shared domain types, AppError codes, repository/store/queue/publication port
  contracts, SiteInput and restricted SitePatch validation. Contracts have no app
  imports. ModelPort request/result/FileTools declarations stay with their later
  producer rather than introducing broken forward imports.
- `normalizeDomain`: HTTP/HTTPS or bare domains, whitespace trimming, lowercase
  and IDNA ASCII conversion. Rejects paths, credentials (including empty user),
  ports (including explicit default ports), empty/populated query and fragment,
  IP literals/alternate numeric IPv4 forms, localhost names, invalid labels and
  backslash/encoded-path ambiguity. It performs no DNS or network checks.
- `authorize`: user creates/reads owned or assigned sites; spec-user additionally
  edits/publishes in scope; admin exports and administers and has global access.
- `createLocalState`: UUID site creation, canonical-domain uniqueness, scoped
  insertion-order cursor pagination, isolated returned snapshots, revision CAS,
  atomic temporary-file flush/rename, failed-write recovery, corrupt-file refusal,
  process-local serialized operations, idempotent close, reopen and production
  refusal. README documents the trusted repository boundary and local demo limits.
- ManualClock for deterministic tests; no real delays.
- Controller-requested bookkeeping: the plan's single status sentence now records
  architecture and implementation-plan approval on 26 October 2026 and execution
  underway. No task requirements or other plan sections were changed.

## RED/GREEN evidence

1. Wrote the two real behavior test files first. Initial runner setup hit
   `spawn EPERM` with Vitest's default forks pool. Selecting the thread pool
   resolved the environment restriction without loosening execution protections.
2. The requested targeted command then failed with missing `sites.js` and
   `local-state.js` modules. This was setup evidence only, not behavioral RED.
3. Added typed inert skeletons. Targeted run: **45 failed, 2 passed / 47**.
   Concrete assertion failures included raw `' HTTPS://EXAMPLE.COM/ '` versus
   `'example.com'`, IDNA mismatch, forbidden actions failing to throw, two
   duplicate creates succeeding, empty persisted-site fields, and corrupt-state
   and production opens resolving instead of rejecting. A few downstream tests
   also hit stub errors; these were not counted as independent assertion evidence.
4. Implemented core rules and local persistence. Full suite: **47 passed**;
   typecheck and build also passed.
5. Added self-review regressions and the clock skeleton. Full suite:
   **3 failed, 48 passed / 51**. Assertions demonstrated `app.localhost` being
   accepted, repeated close releasing a newly opened handle's lock, and injected
   timestamp `0` instead of `1000`. The filesystem failure-recovery regression
   already passed against the first implementation and verifies existing behavior.
6. Fixed those three demonstrated failures. Full suite: **51 passed / 2 files**.
   The clock consumer verifies both initial savedAt 1000 and advanced savedAt 1250.

Tests exercise the real filesystem in isolated temporary directories. There are
no FS mocks, real waits, model calls, paid services or new accounts.

## Final verification

All commands ran from the linked worktree on Windows with Node v24.21.0 and npm
11.19.0. Results were inspected, not inferred from another agent's report.

- `npm.cmd ci --ignore-scripts --offline`: exit 0; reproducible lockfile install;
  51 packages added, 56 audited, 0 vulnerabilities reported.
- `npm.cmd test -- packages/core/test/sites.test.ts packages/adapters/test/local-state.test.ts`:
  exit 0; 51 tests passed in 2 files.
- Bare `npm.cmd test`: exit 0; 51 tests passed in 2 files. Repeated after clean ci.
- `npm.cmd run typecheck`: exit 0.
- `npm.cmd run build`: exit 0; JS, declarations and source maps emitted under dist.
- `git diff --check`: exit 0.
- `npm.cmd ls --depth=0`: all four workspace packages linked; TypeScript 5.9.3,
  @types/node 24.10.0 and Vitest 4.1.12 installed at their pinned versions.
- Built ESM smoke test in **two separate Node CLI processes**: first created
  `HTTPS://RESTART.EXAMPLE/`, closed and exited; second opened the same directory
  and read the same UUID `5425491b-e34a-42c9-85a1-5a44c1d2a2ce` with canonical
  domain `restart.example`. Local demonstration state is ignored by Git.

Initial dependency setup used Vitest 4.0.3; npm's live audit identified one
moderate and one critical development-tool advisory. It was replaced before
implementation with the audited patched 4.1.12 release; final installs reported
zero vulnerabilities. No vulnerable pin remains in the final manifest/lockfile.

## Self-review and integration notes

- Domain uniqueness is checked under the same mutex as persistence. In-memory
  state changes only after rename succeeds. Failed replacement removes its temp
  file, preserves the previous in-memory revision and permits the next write.
- `close()` stops new work immediately, waits for work already accepted, and
  releases its directory ownership only once. Repeated close cannot release a
  successor's lock. Corrupt-open failure also releases ownership for repair/retry.
- List filters before slicing; a cursor must identify a site visible to that
  principal. Caller-visible snapshots cannot mutate stored assignments or input.
- `get` and `compareAndSet` retain the approved signatures without a principal.
  They are trusted internal repository primitives; future request handlers must
  authorize first. `create` and `list` enforce the principal they receive.
- Local state supports one controlling process per directory, not multiple
  processes, cloud synchronization or distributed leases. Temporary-file rename
  avoids partially written JSON; it is not a backup/power-loss durability promise.
- No UI, model, artifact storage, queue implementation, remote adapters or later
  task behaviors were added. macOS/cloud checks are outside this task's local
  registry scope and are not claimed. No material design ambiguity was found.
- `C:/Users/sazur/Desktop/speech` was not modified.

## Commits

- `4258b15` — `feat: add site registry and local persistence` (implementation,
  tests, workspace, documentation, approved-plan status bookkeeping).
- This report is recorded in a following documentation-only commit titled
  `docs: record task 1 implementation evidence`; its hash is in the final handoff.

Git initially refused index.lock in the primary repository's metadata outside
the writable worktree. A narrow Git staging/commit escalation succeeded. Dependency
downloads likewise used narrow npm escalation; there was no auto-review rejection.
