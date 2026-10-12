# Local development

`pnpm dev` starts Cubby with Vite HMR inside workerd. The supervisor prepares
PostgreSQL, WASM, and local auxiliary workers before starting the
app. It seeds the synthetic core corpus through the running Better Auth service
and reports readiness only after the database, fixtures, and Worker agree.

## Start and discover

Install dependencies with `pnpm install`. On macOS, local development defaults
to Apple `container`; run `container system start`. Linux defaults to Docker.
To use Docker on macOS, start its daemon and export
`CUBBY_DEV_SERVICES=docker` for development commands. Both backends use the same
loopback port, owned named volume and checkout database guards. A backend has
its own volume; switching does not transfer existing local data. Then run:

```sh
pnpm dev
pnpm dev status --json
pnpm dev doctor --json
```

The startup output names the app, synthetic login, local resource explorer,
inspector, database, and discovery file. `.cubby-dev/session.json` records the
selected origin, database, profile, process identity, readiness, startup phase
timings, and inspection URLs. Use that file or `pnpm dev status` to discover the
running origin; ports can differ between checkouts. `/__dev/health` reports
runtime identity, while `/__dev/ready` checks database connectivity, committed
migrations, the completed core fixture marker, and that the synthetic USDA
release has loaded (`usdaReady`).
`/__dev/login` signs in the synthetic local
account through real Better Auth on loopback.
Debug Swift apps launched with `--cubby-dev-server <origin>` use
`/__dev/login?native=true` to store the same signed session bearer and session
cache without a browser redirect. This mode accepts only loopback HTTP servers
and rejects redirects; it is absent from release app builds.

A real checkout path determines a stable development id. Its database is
`cubby_dev_<id>` at `localhost:55432`, and its Worker resources are named with
that id. PostgreSQL's container is shared; databases, D1/R2/DO/queue state, and
session files belong to each checkout. Runtime settings are meant for people:
`PORT` (default 3000), `CUBBY_DEV_PROFILE` (`offline`, or `integrations` with
`CUBBY_DEV_VECTORIZE_INDEX`), `CUBBY_DEV_INSTANCE`
(another isolated instance within the same checkout), and `CUBBY_DEV_DB_NAME`
(a branch's own `cubby_dev_<name>` database), and `CUBBY_DEV_SERVICES`
(`apple` or `docker`). Everything else, including
`CUBBY_DEV_ID` and the database name the Worker verifies, is derived by one
resolved profile (`scripts/lib/dev-profile.ts`) and should not be set by hand.
Unset inherited application
database and storage overrides before starting; the supervisor rejects values
that target another database or origin. Local startup ignores production `.env`
and `.dev.vars` files and supplies its own auth/storage values. Worktrees get no
`.env` copy; an opt-in billed tool (live evals, Tester Army) reads its one
credential through `localSecret` (`apps/web/tooling/local-secret.ts`): shell,
then this checkout's `apps/web/.env`, then the primary checkout's. Use it
instead of grepping another checkout's `.env`.

Ctrl-C stops the owned runtime and keeps persistent data. `pnpm dev down` stops
that checkout's supervisor. `pnpm dev reset` stops it and resets its database and
Worker state; start `pnpm dev` again to recreate the corpus (`pnpm dev seed`
reseeds without resetting). Low-level `db:dev:up`, `migrate`, and `down` manage
the shared PostgreSQL service.

## Tooling layout

Local runtime tooling lives in `apps/web/tooling/dev/`. `index.ts` owns the
supervisor and commands; `config.ts` owns main/peer bindings and their small
synthetic datasets; `state.ts` owns portable local identity, guards, and session
contracts. `fixtures.ts` manages auth and fixture markers, while `scenarios.ts`
builds the optional domain graphs. `worker.ts` and `storage.ts` own the local
Worker entry and R2 transport. The warm HMR lane's `dev-runtime.hmr.ts`
verifies dev login, browser HMR, the synthetic USDA/UPC fixtures and local R2
routing against the running session; `storage.unit.test.ts` owns the R2 adapter
contract, and the Problems pack seeder asserts its own failed/pending work.
Build provenance and disposable E2E tooling remain separate.

Core corpus values use an independent seeded Faker instance and the existing
Zod create-input schemas. Scenario states and relationships remain explicit;
random filler does not decide whether work is failed, pending, or complete.

## Fixtures

The core pack contains locations, taxonomy, products, inventory, finance,
projects, tasks, purchases, expenses, and a photo-inventory run. Optional packs
add small synthetic graphs to the running session:

```sh
pnpm dev seed recipes
pnpm dev seed images
pnpm dev seed purchase
pnpm dev seed garden
pnpm dev seed calendar
pnpm dev seed problems
```

The Problems pack adds incomplete entities, a failed photo-processing Run/job,
and an open Run with pending image work. Both work fixtures retain real local
source bytes and avoid provider dispatch. Each pack uses the entity kernel; the
image pack uploads and finalizes real
synthetic bytes through the local storage API. A development-only PostgreSQL
table, `cubby_dev_fixture`, records the pack version and `seeding`, `complete`,
or `failed` state. A completed current pack skips reseeding. Partial or outdated
packs require `pnpm dev reset`, so a failed seed cannot silently duplicate its graph
or report ready based on an unrelated Product count. This marker table is
created by development tooling and has no production migration.

## Profiles and inspection

The default `offline` profile reads USDA from the real release Durable Object,
which the dev Worker seeds with the synthetic release `2000-01`; UPC upstream
lookups are disabled. Images use local R2, and auth uses local
PostgreSQL. External provider operations return unavailable diagnostics.
Purchase-agent starts fail immediately with `dispatch_failed` before an offline
producer can enqueue work. Unexpected queue deliveries are retried and throw
rather than acknowledged as successful work. Telemetry is off unless `CUBBY_DEV_TELEMETRY=true` is explicit.

For billed AI/provider work, use `pnpm dev integrations`. AI requests use the
shared `cubby` gateway with `environment=development`; the Vectorize binding
remains isolated: `CUBBY_DEV_VECTORIZE_INDEX` must start with `cubby-dev-<id>`.
Set `CUBBY_DEV_AI_GATEWAY_API_KEY` explicitly when REST authentication requires
a token. Wrangler must be authenticated for those bindings. This profile runs the local purchase agent
with remote AI and callbacks to the local Cubby Worker; PostgreSQL and storage
remain local. Stop a running offline session before switching profiles.
Integration mode supports HMR development. Built preview currently supports
the offline profile only because the agent's auxiliary entry is served by its Vite
plugin.

Scheduled work does not run automatically. Invoke the real handler when needed
with `<discovered-origin>/cdn-cgi/local/scheduled?format=json&cron=0+12+*+*+*`.
The returned JSON reports the handler outcome; see Cloudflare's
[scheduled-handler reference](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/).

For engineering MCP access, use `<discovered-origin>/api/mcp` with normal OAuth
2.1 authentication. The local login establishes the browser session; it does
not bypass MCP OAuth.

The local R2 shim serves S3-style operations at
`<discovered-origin>/__local-storage/s3/<bucket>/<key>` and public images at
`<discovered-origin>/<key>` for keys beginning with the configured
`R2_KEY_PREFIX/`. It supplies permissive local CORS,
HEAD/ETag metadata, and a single HTTP byte range (206 or 416).
`/cdn-cgi/image/<options>/<key>` passes through the original local bytes; it
does not reproduce Cloudflare CDN resizing, compression, or cache behavior.
Validate those transformations against the deployed boundary when relevant.

The printed resource explorer exposes local bindings; the inspector URL exposes
the Worker debugging target. To inspect PostgreSQL directly, use the connection
shown by `pnpm dev status`. `pnpm --filter @cubby/web preview:cf` builds and runs the
same offline profile through Wrangler with its persistent resources.

## Native iteration and validation

Start the web session, then run `pnpm dev sim --sim <name>` to build, install,
and launch the simulator app against the session's discovered origin. The
launcher sets a development server marker and persists that server choice.
Manual Settings exploration uses the same synthetic account and database.

Disposable test services remain separate from this persistent session.
`pnpm test:e2e:sim` and `pnpm test:e2e:local` use the shared Workerd runtime
with guarded named database leases, and own their native processes
and sanitized replay artifacts; see [validation](agents/validation.md) and
[Apple iteration](../apps/apple/ITERATION.md). A manual local session does not
replace the GitHub merge gate.

For finite simulator smoke or QA journeys in the shared T3 Device panel, set
`CUBBY_E2E_AGENT_DEVICE` to the JSON `{command,targetArgs}` returned by
`device_open`, The harness selects the returned simulator automatically and rejects a conflicting
`CUBBY_SIM_DEVICE` before setup.
The harness keeps the returned launcher, host configuration and session on
every driver command, and leaves the shared session and daemon running.
Single-file `.ad` journeys use `replay` in that session; `test` would fork an
attempt session and conflict with an already-open panel. Replay diagnostics and
root scenario results remain in the sanitized harness bundle.
Watch, input and Tester Army modes keep their owned driver lifecycle and
reject this override.

## Fixture previews and warm HMR validation

The dev-only `/__dev/preview?entity=task&state=edge` route renders the generic
entity list from declaration-backed fixtures. Select a list entity and loading,
error, empty or edge state without creating database rows. The preview entry and
Faker are outside the production import graph.

With this checkout's `pnpm dev` ready, run `pnpm --dir apps/web test:e2e:hmr`.
Configuration inspection needs no live session. Runtime fixtures bind the profile
environment before importing server modules, which capture database settings
at import time. The optional lane discovers the supervisor and verifies its local origin,
checkout id and database before writing. It creates run-owned synthetic records
and deletes only those records after each case, retaining failed deletions for
retry. `dev-runtime.hmr.ts` covers the development Worker's own contracts:
native and one-click dev login mint real sessions, a Vite HMR update reaches the
page without navigation, the synthetic USDA release and UPC cache load, and one
dummy-signed R2 upload is served through signed, public and CDN paths. Sanitized artifacts identify the source revision and fingerprint; source
changes during the run fail provenance. HMR evidence helps local iteration;
GitHub still gates the final head with built Workers.

Default simulator smoke proves search and detail navigation, while headless
proves native-client edits and stored values. UI editing and view switching
require `pnpm test:e2e:sim -- --extended-journey` (or local lane `sim:extended`);
the full journey and its named regressions remain available unchanged.

## Focused browser validation

Use the persistent HMR session to explore fixtures. Acceptance uses a built
Worker, disposable databases, and separate storage. Build once, then run a
focused file or the last failed selection:

```sh
pnpm --dir apps/web build:cf
pnpm --dir apps/web test:e2e tests/e2e/http-api.spec.ts --workers=2
pnpm --dir apps/web test:e2e --last-failed
pnpm --dir apps/web test:e2e:affected
pnpm --dir apps/web test:e2e:watch
```

`test:e2e:affected` reuses the current
fingerprint-checked web build or rebuilds it, then runs Playwright's
`--only-changed=origin/main`, which selects spec
files that changed or import a changed file. It is a local heuristic: specs
can reach app code through the browser without importing it, so an app-only
change can select nothing. Name the spec that covers the route, or run the full `test:e2e`; CI
runs every spec. Append `--list` to preview the selection. Direct runs reject
stale prebuilt output before database setup, so rebuild after editing source. The retained watch command prepares an
initial build and keeps the built Worker and Playwright UI available for
iteration. HMR and watch results serve different validation boundaries.

Read the failed scenario and artifact summary before rerunning. Use
`--last-failed` after a relevant fix; do not repeat an unchanged failure merely
to retrieve its diagnostics. Browser execution remains uncached even when a
matching build and the shared services are reused.
