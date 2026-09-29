# Local development

`pnpm dev` starts Cubby with Vite HMR inside workerd. The supervisor prepares
PostgreSQL, WASM, MCP App assets, and local auxiliary workers before starting the
app. It seeds the synthetic core corpus through the running Better Auth service
and reports readiness only after the database, fixtures, and Worker agree.

## Start and discover

Install dependencies with `pnpm install`. On macOS, install Apple `container`
and run `container system start`; Linux uses Docker. Set
`CUBBY_DEV_SERVICES=docker` to use Docker on macOS. Then run:

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

A real checkout path determines a stable development id. Its database is
`cubby_dev_<id>` at `localhost:55432`, and its Worker resources are named with
that id. PostgreSQL's container is shared; databases, D1/R2/DO/queue state, and
session files belong to each checkout. An optional `CUBBY_DEV_INSTANCE` creates
another isolated instance within the same checkout. Unset inherited application
database and storage overrides before starting; the supervisor rejects values
that target another database or origin. Local startup ignores production `.env`
and `.dev.vars` files and supplies its own auth/storage values.

Ctrl-C stops the owned runtime and keeps persistent data. `pnpm dev:down` stops
that checkout's supervisor. `pnpm dev:reset` stops it and resets its database and
Worker state; start `pnpm dev` again to recreate the corpus. The older
`dev:local` and `db:dev:seed`/`reset` commands remain aliases. Low-level
`db:dev:up`, `migrate`, and `down` manage the shared PostgreSQL service.

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

For billed AI/provider work, use `pnpm dev:integrations` with explicit isolated
development bindings: `CUBBY_DEV_AI_GATEWAY_ID` must name a `cubby-dev...` gateway,
and `CUBBY_DEV_VECTORIZE_INDEX` must start with `cubby-dev-<id>`. Set
`CUBBY_DEV_AI_GATEWAY_API_KEY` explicitly when that development gateway requires
a token. Wrangler must be authenticated for those bindings. This profile runs the local purchase agent
with remote AI and callbacks to the local Cubby Worker; PostgreSQL and storage
remain local. Stop a running offline session before switching profiles.
Integration mode supports HMR development. Built preview currently supports
the offline profile only because Flue's auxiliary entry is served by its Vite
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
`pnpm test:e2e:sim` and `pnpm test:e2e:local` retain their own databases, runtime,
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
pnpm --dir apps/web test:e2e:affected --json
pnpm --dir apps/web test:e2e:affected
pnpm --dir apps/web test:e2e:watch
```

`warm` services are a macOS option; see [test tiers](agents/validation-tests.md)
for external services on Linux. The affected selector's JSON lists specs and
selection reasons without starting services. Execution ensures a fingerprint-
checked build first. Direct runs reject stale prebuilt output before database
setup, so rebuild after editing source. The retained watch command prepares an
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
