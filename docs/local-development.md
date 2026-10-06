# Local development

`pnpm dev` starts Cubby with Vite HMR inside workerd. The supervisor prepares
PostgreSQL, WASM, MCP App assets, and local auxiliary workers before starting the
app. It seeds the synthetic core corpus through the running Better Auth service
and reports readiness only after the database, fixtures, and Worker agree.

## Start and discover

Install dependencies with `pnpm install`. Local development requires macOS and
Apple `container`; run `container system start`. Docker is used by CI test
services, not the local development supervisor. Then run:

```sh
pnpm dev
pnpm dev:status -- --json
pnpm dev:doctor -- --json
```

The startup output names the app, synthetic login, local resource explorer,
inspector, database, and discovery file. `.cubby-dev/session.json` records the
selected origin, database, profile, process identity, readiness, startup phase
timings, and inspection URLs. Use that file or `dev:status` to discover the
running origin; ports can differ between checkouts. `/__dev/health` reports
runtime identity, while `/__dev/ready` checks database connectivity, committed
migrations, the completed core fixture marker, and the USDA/UPC peers.
`/__dev/login` signs in the synthetic local
account through real Better Auth on loopback.
Debug Swift apps launched with `--cubby-dev-server <origin>` use
`/__dev/login?native=true` to store the same signed session bearer and session
cache without a browser redirect. This mode accepts only loopback HTTP servers
and rejects redirects; it is absent from release app builds.

A real checkout path determines a stable development id. Its database is
`cubby_dev_<id>` at `localhost:55432`, and its Worker resources are named with
that id. PostgreSQL's container is shared; databases, D1/R2/DO/queue state, and
session files belong to each checkout. Four settings are meant for people:
`PORT` (default 3000), `CUBBY_DEV_PROFILE` (`offline`, or `integrations` with
`CUBBY_DEV_VECTORIZE_INDEX`), `CUBBY_DEV_INSTANCE`
(another isolated instance within the same checkout), and `CUBBY_DEV_DB_NAME`
(a branch's own `cubby_dev_<name>` database). Everything else, including
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

Ctrl-C stops the owned runtime and keeps persistent data. `pnpm dev:down` stops
that checkout's supervisor. `pnpm dev:reset` stops it and resets its database and
Worker state; start `pnpm dev` again to recreate the corpus (`pnpm dev:seed`
reseeds without resetting). Low-level `db:dev:up`, `migrate`, and `down` manage
the shared PostgreSQL service.

## Tooling layout

Local runtime tooling lives in `apps/web/tooling/dev/`. `index.ts` owns the
supervisor and commands; `config.ts` owns main/peer bindings and their small
synthetic datasets; `state.ts` owns portable local identity, guards, and session
contracts. `fixtures.ts` manages auth and fixture markers, while `scenarios.ts`
builds the optional domain graphs. `worker.ts` and `storage.ts` own the local
Worker entry and R2 transport. `smoke.ts` verifies the complete lifecycle,
including raw browser CORS and failed/pending fixture work, through one command:
`pnpm test:e2e:dev`. Build provenance and disposable E2E tooling remain separate.

Core corpus values use an independent seeded Faker instance and the existing
Zod create-input schemas. Scenario states and relationships remain explicit;
random filler does not decide whether work is failed, pending, or complete.

## Fixtures

The core pack contains locations, taxonomy, products, inventory, finance,
projects, tasks, purchases, expenses, and a photo-inventory run. Optional packs
add small synthetic graphs to the running session:

```sh
pnpm dev:seed recipes
pnpm dev:seed images
pnpm dev:seed purchase
pnpm dev:seed garden
pnpm dev:seed calendar
pnpm dev:seed problems
```

The Problems pack adds incomplete entities, a failed photo-processing Run/job,
and an open Run with pending image work. Both work fixtures retain real local
source bytes and avoid provider dispatch. Each pack uses the entity kernel; the
image pack uploads and finalizes real
synthetic bytes through the local storage API. A development-only PostgreSQL
table, `cubby_dev_fixture`, records the pack version and `seeding`, `complete`,
or `failed` state. A completed current pack skips reseeding. Partial or outdated
packs require `dev:reset`, so a failed seed cannot silently duplicate its graph
or report ready based on an unrelated Product count. This marker table is
created by development tooling and has no production migration.

## Profiles and inspection

The default `offline` profile uses actual USDA and UPC workers with a small
synthetic D1 index and R2 objects. Images use local R2, and auth uses local
PostgreSQL. External provider operations return unavailable diagnostics.
Purchase-agent starts fail immediately with `dispatch_failed` before an offline
producer can enqueue work. Unexpected queue deliveries are retried and throw
rather than acknowledged as successful work. Telemetry is off unless `CUBBY_DEV_TELEMETRY=true` is explicit.

For billed AI/provider work, use `pnpm dev:integrations`. AI requests use the
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
shown by `dev:status`. `pnpm --filter @cubby/web preview:cf` builds and runs the
same offline profile through Wrangler with its persistent resources.

## Native iteration and validation

Start the web session, then run `pnpm dev:sim -- --sim <name>` to build, install,
and launch the simulator app against the session's discovered origin. The
launcher sets a development server marker and persists that server choice.
Manual Settings exploration uses the same synthetic account and database.

Disposable test services remain separate from this persistent session.
`pnpm test:e2e:sim` and `pnpm test:e2e:local` use the shared Workerd runtime
with guarded named database leases, and own their native processes
and sanitized replay artifacts; see [validation](agents/validation.md) and
[Apple iteration](../apps/apple/ITERATION.md). A manual local session does not
replace the exact-head GitHub merge gate.

## Focused browser validation

Use the persistent HMR session to explore fixtures. Acceptance uses a built
Worker, disposable databases, and separate storage. Build once, then run a
focused file or the last failed selection:

```sh
pnpm --dir apps/web build:cf
CUBBY_TEST_SERVICES=warm pnpm --dir apps/web test:e2e tests/e2e/http-api.spec.ts --workers=2
CUBBY_TEST_SERVICES=warm pnpm --dir apps/web test:e2e --last-failed
CUBBY_TEST_SERVICES=warm pnpm --dir apps/web test:e2e:affected
pnpm --dir apps/web test:e2e:watch
```

`warm` services are a macOS option; see [test tiers](agents/validation-tests.md)
for external services on Linux. `test:e2e:affected` runs the cached Nx
`build-cf`, then Playwright's `--only-changed=origin/main`, which selects spec
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
matching build and warm services are reused.

## Measured feedback

Local acceptance samples on 2026-09-29 (dirty source, macOS, warm PostgreSQL
service) measured a fresh development session at 26.2 seconds, a later warm
session at 23.5 seconds, and a browser HMR update at 250 ms. The full local
runtime acceptance passed 13 scenarios in 126.8 seconds. The focused built
Worker HTTP/API run passed four scenarios with two browser workers in 15.3
seconds; warm service discovery and database-template reuse took 46 ms and
13 ms respectively.

The WASM cache key previously changed with inherited logging settings. After
normalizing the build environment and excluding `RUST_LOG`, the warm freshness
phase reused its matching artifact in 740 ms instead of restoring it through
Nx in the earlier 6.4-second sample. Compiler flags still invalidate it.
Runtime startup and initial application loading remain the largest development
phases (about 8 and 10 seconds in the warm sample).

Native acceptance verified real login, search, editing, image rendering, and a
bare relaunch retaining the selected local server. Its cold sample took 22.3
seconds for FFI and 221.4 seconds for Xcode; authenticated requests after bare
relaunch took 96–120 ms. These samples preserve useful baselines, but do not
establish a controlled overall before/after speedup. Concurrent host workloads
produced substantially slower startup samples. Physical-device networking,
live provider quality, CDN transformations, and production signature enforcement
need separate validation.

Native E2E app builds preserve `CubbyKit/Package.resolved` as the package's
owned lockfile. Xcode can write its app graph (including app-only dependencies
from `apps/apple/project.yml`) into that local package file while resolving.
`withKitPackageResolution` verifies every Kit pin remains unchanged, permits
only added package URLs declared by the app, and restores the original Kit
serialization after success or failure. A changed Kit pin fails acceptance;
update Kit pins through its package workflow, rather than accepting build
churn. The generated Xcode project owns its app resolution state. Build
fingerprints and simulator cache certification are recorded after restoring
the Kit file, so clean final-head artifacts remain replayable.
