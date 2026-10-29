# Site Factory

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
