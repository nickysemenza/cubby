# Local development

`pnpm dev` starts Cubby with Vite HMR inside workerd. The supervisor prepares
the owned PostgreSQL endpoint, then WASM and generated artifacts before any
corpus initialization (including low-level ready/migrate/reset), and local auxiliary workers before starting the
app. A shared IntegreSQL corpus template supplies the synthetic core household;
the Worker restores its bundled photos into checkout-local R2 and reports
readiness only after the database, fixtures, and Worker agree. Vite compiles
application/auth routes on their first request; startup does not warm SSR with
an otherwise unused auth-session request.

## Start and discover

### Cursor Cloud

The Cloud Agent environment starts Docker and `pnpm dev` on boot. Readiness is
`http://localhost:3000/__dev/ready`; sign in at `http://localhost:3000/__dev/login`.
On this Linux image the dev server accepts `localhost` (IPv6) and refuses
`127.0.0.1`. Development and tests share container PostgreSQL and IntegreSQL.
Local commands start them on first use ([development](development.md)); CI uses
its externally managed service pair.

### Checkout runtime

Install dependencies with `pnpm install`. On macOS, local development defaults
to Apple `container`; run `container system start`. Linux defaults to Docker.
To use Docker on macOS, start its daemon and export
`CUBBY_DEV_SERVICES=docker` for development commands. Both backends use the same
checkout database guards. Neither keeps a data volume: after container
recreation, the next `pnpm dev` rebuilds its templates. Then run:

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

Dev sessions and template recovery share one process-liveness contract: `alive`
means equal verified birth identities; `dead` means an absent PID or a verified
different birth in the same identity format; everything unreadable or in another
format is `unknown`. Unknown ownership never authorizes termination, replacement,
reset, or template discard. Unprefixed legacy identities are unknown because their
original timezone/locale was not recorded. For local birth uncertainty, the
diagnostic names the PID: stop that local process with `kill <pid>`, then run
`pnpm dev down` before retrying. Foreign-host or missing-service-incarnation
uncertainty requires shared-service recovery instead; see
[template recovery](development.md#worktrees-and-test-services). Session and
persistent data stay intact until ownership is resolved.
`/__dev/login` signs in the synthetic local
account through real Better Auth on loopback.
Debug Swift apps launched with `--cubby-dev-server <origin>` use
`/__dev/login?native=true` to store the same signed session bearer and session
cache without a browser redirect. This mode accepts only loopback HTTP servers
and rejects redirects; it is absent from release app builds.

A real checkout path determines a stable development id. Its database is
`cubby_dev_<id>` (published at `localhost:55432`), and its Worker resources are named with
that id. PostgreSQL's container is shared with every checkout and with test runs'
IntegreSQL databases; databases, D1/R2/DO/queue state, and session files
belong to each checkout. The server runs with JIT off (Neon's PostgreSQL has
no JIT provider; the local image's LLVM compiler otherwise adds substantial
compilation time to complex quality queries) and durability off (`fsync`,
`synchronous_commit`, `full_page_writes`) and no volume: local data is
synthetic. Databases survive runtime and idle restarts for the lifetime of the
checkout. Each clone's database comment records the absolute checkout path;
every preparation refreshes that label, including an existing database.
Provisioning collects only idle databases whose name exactly matches the default
id derived from the labelled, now-missing checkout path. Explicit names and
instance names are retained unless they match that default derivation. The
requested target is excluded, active connections prevent collection, and DROP
never uses FORCE for collection.

IntegreSQL coordinates one migration-keyed base template for tests and dev.
A second layer, keyed by migrations, `LOCAL_FIXTURE_VERSION`, corpus/application
sources, shared code and fixture bytes, seeds once through application code.
The key follows the corpus preparation entry's runtime module graph with esbuild,
including dynamic imports, server calculations and write paths, tooling fixtures,
factories and scenarios. All workspace packages' runtime sources and package
manifests (including USDA and Worker tracing), workspace resolution configuration,
Rust/WASM inputs, migrations, lockfiles and bundled wardrobe PNG bytes are also
hashed. Unrelated UI sources
(features, UI, routes and components outside that graph) do not invalidate the
seed. Existing checkout edits survive startup; `pnpm dev reset` adopts the
current template. For an exceptional dependency outside the discovered graph or
a new reference day, run `pnpm dev reset --reseed`. It persists a fresh generation
in that instance's state directory, seeds a new template, and uses it on later
resets; other instances keep their generations.
It inserts the synthetic account with Better Auth's password hasher, then runs
the entity kernel and specialist repositories. Before a Worker exists, its
background publications are stored in the template's development-only
`cubby_dev_background_task` outbox. Clones hand those envelopes to the local
Worker queue on startup, deleting them only after acceptance. A partial handoff
may redeliver; handlers retain their freshness checks. Import, account and corpus
timings
are logged separately. Once finalized, a new checkout database is a physical
`CREATE DATABASE … TEMPLATE …` clone. Test pools remain per namespace and
checkout; idle IntegreSQL recycling drops only `integresql_*` databases, so
checkout clones survive and a discarded template rebuilds on demand.

On Apple container, the supervisor derives `CUBBY_DEV_DB_ADDRESS` from the
container's own IP and uses its port 5432 for Worker and local Hyperdrive
connections, bypassing the published-port proxy. Docker uses loopback 55432.
Every preparation entry point inspects the owned container before connecting;
an inherited address must equal that derived endpoint. This address is derived,
not a user override. Repeated readiness/reset preparation carries the verified
address and its database URLs together; it must never mix a direct address with
inherited loopback URLs. The container preloads
`pg_stat_statements`; database preparation enables it for the selected
checkout, providing normalized query counts, execution times and buffer
statistics for local performance investigations. A container started with
other settings is recreated empty at the next `pnpm dev` or test run; active
local clients disconnect, and each checkout's next `pnpm dev` rebuilds its
database. Postgres version and query semantics
should track production; connection and cache limits remain sized for the local
container rather than copying Neon's autoscaled values. Keep the core corpus
small and opt into the performance pack below for scale-sensitive work.
Runtime settings are meant for people:
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

Ctrl-C stops the owned runtime and keeps the checkout's database. `pnpm dev down` stops
that checkout's supervisor. `pnpm dev reset` stops it, re-clones its database from the current corpus template,
and removes its Worker state. Add `--reseed` to build a fresh corpus generation
instead of reusing a finalized template. The next startup restores the three bundled PNGs
into local R2 when missing. `pnpm dev seed` checks the core marker without
resetting edits. Low-level `db:dev:up`, `migrate`, and `down` manage
the shared PostgreSQL service.

A session nobody uses ends on its own, so a settled agent thread cannot leave
gigabytes behind. After 30 minutes without an HTTP request or a watched file
change, the runtime stops the supervisor (`CUBBY_DEV_IDLE_MINUTES`, `0` keeps
it). An open HMR socket is not activity: forgotten preview panes and test
browsers hold one indefinitely. A runtime whose supervisor was killed closes
itself within 15 seconds. Built preview (`pnpm --dir apps/web preview:cf`)
uses the same supervisor and runs `vite preview` against the native Build Output.
Its explicit preview build includes synthetic dev seeding, which production
bundle checks exclude. Preview provenance cannot satisfy production prebuilt reuse.
The lifecycle plugin's idle and orphan checks currently apply to HMR only.

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

The default core pack is a connected synthetic household of a few hundred
records, shared with browser screenshot exploration and the native QA lane.
`tooling/scenarios/corpus.ts` owns curated pantry/recipes/meals, garden/seed
products/plantings, maintenance/tools, wardrobe/photos, purchases/expenses/accounts,
calendar work, email evidence, and pending/failed photo Runs. Faker adds list
density; it never chooses the story relationships or activity states. Every
persisted declared entity has records. Coverage is read back from the generated
entity manifest and missing seed cases fail startup; USDA is reported separately
because its synthetic release belongs to the Worker rather than PostgreSQL.

The household includes stored shirt/boots/label photos, Inventory's related
Product images, emoji/entity-icon fallbacks, an explicitly missing image attachment,
long names and multiline facts. Writes use the entity kernel or the existing
specialist repositories (cookbook provenance, meal food, image attachments, Runs).
Email evidence uses the synthetic mail fixture shape without importing or dispatching
providers. Inventory remains unchanged when meals are logged.

Faker uses a fixed independent seed. Story chronology (projects, purchases,
expenses, settlement, transfers, sowing work, plantings, journal entries, email,
and meals) is anchored to the household-local day when the corpus template is seeded; an
explicit `referenceDate` makes artifact dates reproducible. Reseeding a completed
pack is a no-op. Reset adopts the current template and retains its chronology;
a changed template hash or a recycled template seeds a new reference day.
Background tasks always use a queue; publishing nonempty work without a
`BACKGROUND_QUEUE` producer throws with the publication source. Post-commit
publication errors remain logged and reported, with durable stale markers for
repair. No Node fallback runs handlers. Node opt-in pack writers forward queue
envelopes to the running development Worker at `/__dev/background-tasks`; the
receiver checks the writer's database identity before accepting work. Opt-in
packs use the discovered session origin. Built workerd harnesses install
their queue producer for Node scenarios, retaining the selected profile's
consumer routing.
Integration tests install `captureBackgroundQueue()` and explicitly `drain(db)`
when asserting consumer effects. Workflow finalizers and retry fallbacks also
need a producer even when a test reads only synchronous writes. The bounded
drain runs real handlers, including
follow-up publications, and retains a failed task for diagnosis.

Optional packs still add small focused graphs to the running session:

```sh
pnpm dev seed recipes
pnpm dev seed images
pnpm dev seed purchase
pnpm dev seed garden
pnpm dev seed calendar
pnpm dev seed problems
```

For performance investigations, `pnpm dev seed performance` adds a larger
connected history: 6,000 Products, 12,000 Expenses, 8,000 Emails with
original-content records, 5,000 completed mail Runs and their outcome receipts, 1,000 Purchases, and
3,000 kit edges. Nested kits, explicitly priced siblings, unpriced stock,
signed exits and future Expenses exercise the same pricing, quantity and
Email-history queries as real records. Values and relationships are entirely
synthetic and deterministic; providers are never dispatched. Three quarters of
originals include 32 KiB of fixed deterministic padding, mixing raw hash text
with repeated synthetic prose and HTML, and short or absent snippets. The rest
model cleared text. This exercises out-of-line TOAST reads with both
compressible and incompressible originals rather than just row counts.
Fingerprints are derived
from the original content and reused by Email, Run rosters and receipts; later
content clearing preserves those fingerprints and records its clearing time.
The full pack is opt-in; core development stays small and CI uses only a small
copy of the graph. Volume rows are inserted in
bounded batches in one transaction, with database identity/relationship constraints
active. The pack then uses the canonical bulk audit and search writers; it does
not replay interactive commands for every historical record. It updates planner
statistics before the first reads. Its real-database
regression checks relationships, ledger totals, search/audit coverage, historical
Run outcomes and a query-work budget. Seeding time is setup time,
not request latency. Historical mail outcome receipts use the admitted
`OrderMail.id` as their work key and its checksum as their fingerprint. Validate
them through Run detail, including the receipt's completion time: receipt counts
alone cannot detect a projection falling back to current Email status.
Use a separate instance to keep ordinary development small:

```sh
CUBBY_DEV_INSTANCE=performance pnpm dev
CUBBY_DEV_INSTANCE=performance pnpm dev seed performance
```

Use that instance's discovered origin and synthetic login to measure Run and
Work queue navigation, first usable rows, scrolling and concurrent requests.
Compare query plans and request counts as well as elapsed time. Record initial
and repeated requests separately; a fresh browser does not establish a cold
Postgres cache. Local workerd/Postgres exposes query work and browser request
waterfalls, but Cloudflare/Hyperdrive connection behavior and Neon compute/cache
effects still require separate deployed measurements. Local results do not prove
production page latency.

The Problems pack adds incomplete entities, a failed photo-processing Run/job,
and an open Run with pending image work. Both work fixtures retain real local
source bytes and avoid provider dispatch. Interactive fixture packs use the entity kernel; the
image pack uploads and finalizes real
synthetic bytes through the local storage API. A development-only PostgreSQL
table, `cubby_dev_fixture`, records the pack version and `seeding`, `complete`,
or `failed` state. A completed current pack skips reseeding. Partial or outdated
packs require `pnpm dev reset`, so a failed seed cannot silently duplicate its graph
or report ready based on an unrelated Product count. This marker table is
created by development tooling and has no production migration. The shared
household has its own `cubby_household_fixture` completion marker using the same
`LOCAL_FIXTURE_VERSION` as the dev pack, with
the same refusal of partial or outdated seeds. Dev databases are ephemeral;
fixture upgrades use `pnpm dev reset` followed by `pnpm dev`.

Browser screenshot/exploration runs use the explicit `Household exploration`
Playwright project via `pnpm test:e2e:household`. Its spec seeds the shared
household in `beforeAll` on the existing runtime, without another worker-scoped
option. Required desktop regression shards exclude this project and retain
small fixtures. `household-exploration.spec.ts` exercises the graph through the
browser and saves a synthetic wardrobe screenshot.
`pnpm test:e2e:sim -- --qa` loads this same household before its journey-specific
fixtures. The focused `--qa-photo-completion` guard keeps its small fixture.

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
a token. cf must be authenticated for those bindings. This profile runs the local purchase agent
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

Port probes do not reserve ports. If Vite/workerd exits with `EADDRINUSE`
before readiness, the supervisor reaps that launch, selects fresh app
and inspector ports, re-resolves all origin-derived settings and rewrites the
session discovery file before relaunching. Preview retries rebuild the native
Worker output with the newly resolved bindings. It retries at most three times;
other failures and exits after readiness are reported directly.

The printed resource explorer exposes local bindings; the inspector URL exposes
the Worker debugging target. To inspect PostgreSQL directly, use the connection
shown by `pnpm dev status`. `pnpm --filter @cubby/web preview:cf` builds and runs the
same offline profile through Vite preview with its persistent resources.

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

For finite simulator smoke, QA or input journeys in the shared T3 Device panel, set
`CUBBY_E2E_AGENT_DEVICE` to the JSON `{command,targetArgs}` returned by
`device_open`, The harness selects the returned simulator automatically and rejects a conflicting
`CUBBY_SIM_DEVICE` before setup.
The harness keeps the returned launcher, host configuration and session on
every driver command, and leaves the shared session and daemon running.
Single-file `.ad` journeys use `replay` in that session; `test` would fork an
attempt session and conflict with an already-open panel. Replay diagnostics and
root scenario results remain in the sanitized harness bundle.
Watch and Tester Army modes keep their owned driver lifecycle and
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

The Cloudflare Vite plugin v2 emits `.cloudflare/output/v0/` from
`cloudflare.config.ts`; the test runtime reads that output rather than a
generated Wrangler config. Its public Wrangler harness API remains available
for binding access, Durable Object controls, Workflow introspection and logs.

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

## Build and cache constraints

Package contents are shared through pnpm's store; a checkout's apparent
`node_modules` size is not its exclusive disk use. Compare filesystem free
space before and after cleanup. Manifest peer extensions preserve types that
would otherwise work only through checkout-local hoisting. The workspace
manifest and lockfile own install settings and pins.

Generated/WASM/native preparation is owned by `scripts/ensure.ts` and the
commands that consume its outputs. Missing output must be restored even when
inputs are unchanged; a cheap marker that overlooks incomplete packages is
unsafe. Shared Cargo target output uses content fingerprints and the tracked
workspace lockfile. Check a local Cargo path patch before diagnosing an upstream
API mismatch as an installer problem.

Keep Xcode DerivedData and SwiftPM build products isolated by checkout:
intermediates encode source paths and concurrent builds share a build database.
Compiler caches can share content-addressed work, not that mutable graph.
Preserve TypeScript incremental build-info within its checkout rather than
copying an old one after a large rebase. Under `--noEmit`, the first edit can
invalidate importer signatures even when only a function body changes. Keep
RPC interfaces in type-only leaves and generated environment types off the
Worker entry/route tree; global declarations can widen invalidation to the
whole program. Declaration emit and aggressive Go memory limits measured
worse than this structure in the retained diagnostics.
