# Site Factory

Task 1 provides a registry and local demonstration persistence. It does not yet
generate or publish websites, call a real model, or synchronize cloud state.

Use Node 24.21.0 or newer in the 24 LTS line and npm. Local normalized storage uses the built-in node:sqlite API; extension loading is disabled. From the repository root:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

The build emits Node ESM and declarations under `dist/packages/`. The workspace
contains contracts, core domain rules, adapters, and testing utilities.

`createLocalState(directory, clock)` opens a local registry. Call `close()` before
reopening the directory. Every successful mutation flushes a temporary file and
renames it to `state.json` before returning. Writes run under a process mutex; an
open directory cannot have two live handles in the same process. Run **one
controlling process per directory**. The adapter provides neither a distributed
lock nor cloud synchronization and refuses to open with `NODE_ENV=production`.
Corrupt state raises `INVALID_INPUT` and preserves the original file. The atomic
replacement protects against partial JSON writes; this is not a backup system or
a guarantee against filesystem or power failure.

Site IDs are generated UUIDs. Creation starts at revision 0; successful
`compareAndSet` increments the revision. Identity and domain are immutable; patch
fields cover assignments, input, draft/publication pointers and status. Input
updates provide a complete `SiteInput` with the same canonical domain. Lists use
insertion order, return only owned/assigned sites to user/spec-user, and give admin
all sites. Pass `nextCursor` back unchanged; page sizes are 1–1000 (default 100).

`authorize` enforces the approved role matrix. User can create/read scoped sites;
spec-user can additionally edit/publish scoped sites; export and administration
require admin. `get` and `compareAndSet` are trusted repository primitives without
a principal parameter: the API/service caller must authorize before invoking them.
Roles must come from the trusted server identity rather than a request body.
