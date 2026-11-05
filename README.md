# Site Factory

## Current application — 0.5.0

An Electron desktop client connects to a shared API. Generation runs on the server through DeepSeek; clients can close while jobs continue. The current interface uses Russian labels and a soft dark shadcn/ui theme.

- Login and password authentication, one-time registration invitations valid for 20 minutes, and full access for active members.
- Single-site and batch generation with reference previews, automatic style/reference selection, and a required mentioned link.
- Linux hosting preparation over pinned SSH, persistent IPv4 allocation, automatic DNS and HTTPS publication, ZIP updates and rollback.
- Namecheap and GoDaddy integration. The configured protected-domain policy applies on the server.
- Encrypted backup and restore, including Windows/Linux secret migration. Restored operations remain paused until connections are reviewed.
- API deployment on Windows x64 or Ubuntu/Debian x64. Clients use HTTPS by IPv4 with certificate verification; a `.sfconnection` file changes the server address without a domain or client rebuild. No web administration panel is served.

See [API installation and migration](docs/operations/api-portability.md), [Linux publishing hosts](docs/operations/linux-host.md), and [UI requirements](styles_w-b.md).

The active application is in `apps/client`, `apps/server`, and `apps/desktop/src/web`. Shared contracts, queue, storage adapters and generation logic remain in `packages/*` and `apps/worker`.

Using Node 24.21+ in the 24 LTS line:

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run build:server
```

`scripts/build-client.mjs` builds the Electron client after the server/UI build and requires a local public client connection configuration. `scripts/package-api.mjs --linux` creates the Linux deployment package. The Windows package additionally requires PostgreSQL 18 binaries under `.local-state/tools/pgsql`; see the deployment instructions. Local data and release binaries are intentionally excluded from Git.

Acceptance for 0.5.0 includes 54 server tests, native-client smoke tests, real API startup/restore on Windows and Ubuntu, and a real test backup transfer from Windows to Linux. Full dependency provisioning on completely clean Windows/Linux machines remains to be verified. IPv6 publication and load acceptance for 256 sites are separate future work.

## Earlier local and managed architecture

The following describes the earlier local/Tauri and managed modes retained in the repository. Its editing and role-based workflows are not the current Electron application workflow.

Desktop control panel, durable generation/edit queue and static website publication. The panel is in Russian; website content is English HTML/CSS with small vanilla JavaScript. AI edits create checked candidates; accepting a candidate updates the draft and publishing is explicit. The first checked generation is automatically published when publication is configured.

Local demo uses original templates and a deterministic fake model without external calls. Local live mode uses an explicitly configured model and local SQLite/artifact storage. Managed mode uses Supabase Auth/PostgreSQL, private R2 resources and trusted enrolled worker devices; an authorized panel can queue work without local model credentials. Offline workers delay new work; existing published sites remain on hosting. Capability flags describe configured operations, not verified live service health.

Use Node 24.21.0 or newer in the 24 LTS line and npm:

~~~powershell
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
~~~

The workspace contains contracts, core rules, adapters, worker, control API and React desktop UI. Build output is Node ESM under dist and the desktop web bundle. Local data uses normalized SQLite transactions with revision CAS and a single controlling native process. The native private persistence permit is internal; ordinary production server code cannot opt into local demo persistence. Close handles before reopening a data directory. Independent encrypted backups and restore quarantine are separate from ordinary persistence.

Managed mutations resolve fresh server membership/scope and retain one operation per site, generation-fenced leases and publication reservations until outcomes are known. Source files and backup data never become executable runtime inputs. Registry pages are bounded to 1–100 rows with opaque cursors. User can create and read scoped sites and cancel their own generation; spec-user can edit/publish scoped sites; administration and source export require admin.

See [development](docs/development.md) and [pilot report](docs/pilot-report.md) for configuration, packaging and explicit platform/service acceptance boundaries. Local fixtures and historical binaries do not prove live provider, native platform or clean-machine acceptance.
