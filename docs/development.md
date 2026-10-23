# Development reference

Architecture, commands, testing, deployment and the HTTP API. For starting and
troubleshooting a dev session, see [local development](local-development.md).
For what Cubby is and how its entities fit together, see the
[README](../README.md).

## TypeScript imports

Keep nearby implementation files and colocated tests on relative imports. For
distant web source dependencies, use `~/…`; for web tooling dependencies loaded
through the web resolver, use `tooling/…`. Three or more parent traversals are a
signal to look for an existing alias or package export. Do not add a second
source-root spelling such as `@/` alongside `~/`.

Across workspace packages, use their `@cubby/<package>/<subpath>` exports and
declare the dependency in the consuming package. Do not add tsconfig mappings
into another package's source tree or create barrels only to shorten imports.
Generators may read declaration files and fixtures directly when those files
are their compilation inputs rather than a package API.

TypeScript `paths` describe resolution; they do not rewrite emitted imports.
The web Vite and Vitest configurations support the web aliases. Scripts run
directly by Node use explicit `.ts` extensions for relative imports and must not
depend on web-only aliases. Filesystem paths, `new URL(…, import.meta.url)` and
glob patterns are not module specifiers; preserve their runtime semantics.
The [repository typecheck boundary](#typechecking) also constrains which imports
must use aliases.

## Architecture

```
TanStack Start  →  Entity Kernel  →  Repo  →  Database
Start workflows ───────────────↗
MCP / jobs      ───────────────↗
Start streams   →  cancellable workflow streams
```

- Entity declarations in `packages/schemas/src/entity-definitions/*.entity.ts`
  compile into the manifest, schema bindings, browser roster, filter catalog,
  kernel capabilities and contract cases. `pnpm generate` rejects invalid
  declarations, and `pnpm check:clean` proves generation leaves the tree
  unchanged. New-entity work starts at [entities](entities.md).
- Shared Zod concepts belong to their domain's leaf schema module in
  `packages/schemas/src`; consumers import that owner rather than redeclare its
  enum or object. Compose related projections with `extend`, `pick`, and `omit`,
  keeping read/write constraints, defaults, nullability, and unknown-key behavior
  explicit. Identical shapes alone do not make unrelated domain concepts shared.
- `executeEntity` is the baseline CRUD, filter, search and relation interface.
  Every other operation is a contract in `apps/web/src/contracts/`, implemented
  once in a domain's `operations` module
  (`src/server/domains/<domain>/operations.server.ts` or `operations/*.server.ts`).
  The browser, HTTP API and MCP are adapters over it. Generated browser module
  ownership and command loading live in [browser cache policy](entities.md#browser-cache-policy).
  HTTP `httpWire` projections can narrow unused optional native input fields
  without narrowing browser contracts. The calendar's typed window retains date
  limits and kinds; web queries additionally accept source filters. Use
  `safeExtend` when extending a refined schema so its refinements survive.
- The server is domain-first ([ADR 0019](adr/0019-domain-first-server-layout.md)):
  `src/server/domains/<entity>/` per manifest entity plus cross-entity feature
  folders (`purchase-import`, `photo-import`, `calendar`, …),
  `src/server/generic/<capability>/` for entity-agnostic capabilities (merge,
  removal, search, embedding, problems, list, …), and platform folders (`db/`,
  `entity-kernel/`, `http/`, `operation-runtime/`, `workflows/`,
  `observability/`, `mcp/`, `ai/`). The client mirrors the domain names in
  `src/features/<domain>/`; `src/entity/` is the generic entity platform and
  `src/ui/` the shared component kit.
- Services own workflows and external enrichment. Repositories own
  transactions, invariants and entity-specific SQL. `Database` is a
  request-scoped handle, and repository helpers resolve its Drizzle client.
  `cubby/domain-layers` keeps imports flowing operations → service → repo → db.
- Unit conversion uses `@cubby/recipebridge`, which wraps Rust
  [ingredient-parser](https://github.com/nickysemenza/ingredient-parser). Call
  `wasm` from `~/lib/wasm` for common synchronous compute. Worker-only
  capabilities use `wasm` from `~/server/wasm`. Conversions chain through a product's unit mappings, e.g.
  `2 cups → $5.00 → 333g`. Amount display rules also live in Rust; web and
  UniFFI adapters forward to the same functions, with cross-client cases in
  `packages/shared/golden-vectors/display-format.json`.
  Physical conversions share density and nutrition mappings, but use one
  product's package mappings per route. Conflicting package interpretations
  remain unknown even when needs share one authored unit; only absent conversion
  routes allow availability to fall back to that unit. Costing keeps the selected conversion path with its result;
  recipe recursion marks the root before expanding sub-recipes. Needs and meal
  calculations share the same validated yield-ratio conversion.
- `pnpm wasm` prepares three packages through the shared
  [artifact preparation entrypoint](../scripts/ensure.ts) into
  `packages/wasm`. The Worker and Vitest load the full build, `worker/`. The browser
  loads `browser/`, built with only the `wasm` feature, without Worker-only `html`, `ai-usage`, and `model-images`
  features (`compact_email_html`, `parse_scraped_recipe`,
  `gateway_call_usage`). Only the cookbook import loads
  `@cubby/recipebridge/cookbook` (the sibling `cookbook-wasm` crate). Put a new
  Worker-only export behind one of those features. The package root's types
  describe the browser build; `@cubby/recipebridge/worker` exposes the full
  interface and is restricted to `src/server`. Package conditions select the
  browser build or the shared `packages/wasm/workerd.js` initializer; both
  workerd subpaths resolve to that one module. Node tests use the full build.
  `check-client-bundle.ts` checks each package lands in the right bundle.
  Cookbook EPUB estimates and extraction use the same deployment options:
  Sonnet 5 first, Haiku 4.5 for the second opinion, then Luna. Anthropic calls
  require the gateway's `subscriber-credit` BYOK alias without wholesale
  fallback; non-2xx responses reach the crate's existing retry/model ladder.
  Luna tries ChatGPT subscription funding before paid gateway funding. The
  forwarder folds completed or incomplete Responses SSE into the response JSON
  expected by the extractor, preserving truncation output and usage. Only explicit subscription quota
  or unavailable codes permit a paid rerun; other errors and cancellation stop
  the call. Failed subscription attempts are recorded separately.
- USDA data comes from one `USDA_RELEASE` SQLite Durable Object per USDA
  release in the web Worker, called over typed RPC
  ([ADR 0008](adr/0008-usda-release-durable-object.md)). The request-scoped
  client is `apps/web/src/server/clients/usda.ts`; it memoizes lookups within
  a request and nothing else caches USDA reads. List and search rows omit the
  full nutrient table (`usdaFoodListRow`); a single-food read returns it.
- Purchase imports run in the web Worker: Pi's Mail import and photo agents
  (one Durable Object per Run), and a member's Claude/Codex Burn-down through
  the public MCP tools ([ADR 0010](adr/0010-mail-import-unattended-burn-down-interactive.md)).
  The map of queue events, Run services and owning files is
  [`apps/web/src/server/domains/purchase-import/service/README.md`](../apps/web/src/server/domains/purchase-import/service/README.md).
- OpenAI Responses calls use the household's ChatGPT plan when connected in
  Settings, retaining the declared Luna/Sol choices. `CHATGPT_PLAN` owns OAuth
  credentials and serializes rotating refreshes. Other providers and embeddings
  use AI Gateway through the shared production egress Durable Object. It
  admits managed-credential traffic under an aggregate rolling window and
  concurrency cap, preserves streaming/provider headers, and shares 429
  cooldowns. ChatGPT subscription traffic bypasses Gateway admission. Local
  integrations, live evaluations and production share `cubby`, with environment
  metadata retaining attribution. Pi's funding order is documented in
  [Infrastructure](infrastructure.md#claude-subscriber-credits). [ChatGPT setup](runbooks/chatgpt-plan.md) explains
  local authorization, the read-only account model catalog, limitations, and
  how each `AiUsage` row records its transport.

The interactive `/ai` Smoke tests tab covers every active AI feature. Mailbox
triage and relevance probes use synthetic original mail; research source support
compares a proposed fact with a synthetic retained catalog observation. These
probes share production request builders and feature/subscription settings;
the AI budgets and background funding waits at credit and paid admission are
verified by their PostgreSQL and Worker contracts separately.

## Commands

[Root package scripts](../package.json) own command names; package-local
scripts live in their `package.json`. Use [local development](local-development.md)
for dev sessions, [validation](agents/validation.md) for check selection,
[CI](ci.md) for hosted lanes, and [production migrations](runbooks/production-migrations.md)
for staged rollouts. Dependencies and toolchain pins belong in manifests,
lockfiles, `.nvmrc`, and `rust-toolchain.toml`, not this command reference.

Provider resources and secrets are in [infrastructure](infrastructure.md).
Upstream metadata workarounds are in [dependency exceptions](dependency-exceptions.md).

A USDA release is built locally from FoodData Central's CSV download and
loads itself into its Durable Object:

1. `pnpm --dir packages/usda release:build --csv <csv-dir> --release YYYY-MM --out <dir>`
   writes `<dir>/YYYY-MM/shard-NNNNN.ndjson.gz` and `manifest.json`.
2. Upload them to the `cubby-usda-releases` bucket under `YYYY-MM/`, the
   manifest last (`cf r2 objects put YYYY-MM/<file> --bucket-name
   cubby-usda-releases --file <path>`).
3. Set `USDA_ACTIVE_RELEASE` in `apps/web/cloudflare.config.ts` and deploy. Reads
   fail with the load's progress until the release is ready.
4. Open `/api/debug/usda-release` signed in (or with `x-api-key`): the first
   request starts the load and every request reports shard progress, size,
   or the raw failure. `?probe=1` on a ready release times a search and a
   batch lookup.
5. Once ready, `POST` to the same route: Product links to superseded food
   revisions advance to the current revision, and the response lists each
   advance. A `POST` on a failed load resumes it instead; on a loading one it
   returns the progress. Re-running it advances nothing new.

The dev Worker seeds its `USDA_RELEASES` bucket on its first request with the
synthetic release `2000-01` (`apps/web/tooling/dev/usda-synthetic-release.ts`):
three foundation foods (9900001–9900003) and one branded food (9900010, UPC
`299000000106`, superseding 9900009). The E2E harness seeds the same release.
`/__dev/ready` stays 503 with `usdaReady: false` while the release loads and
reports the raw error if the load fails. Changing the synthetic foods needs a
new release id or `pnpm dev reset`, because a loaded release object keeps its
data.

Changing the release tables bumps `USDA_RELEASE_GENERATION` in
`packages/usda/src/release/store.ts`, which reloads the release from the same
shards under a new object name.

### Neon cache diagnostics

The migration series installs the `neon` extension when the host provides it;
local pgvector Postgres skips it with a notice. It exposes compute-wide cache
statistics without changing application tables. Use Neon MCP
`inspect_database` with `check: "lfc-hit-rate"` or `check: "working-set"`, or
run `neon inspect db lfc-hit-rate` / `neon inspect db working-set` against the
intended production branch. These measure cache efficiency and the hot working
set, not a complete breakdown of process RAM. Statistics reset when compute
restarts; interpret them after representative traffic. See the
[Neon extension documentation](https://neon.com/docs/extensions/neon).

## Typechecking

Use `pnpm typecheck:web` during app development. It emits compact annotated
server boundary declarations, checks and emits the repository producer,
then checks the remaining server and client. Each checker runs sequentially in
its own process so their live heaps do not overlap. Implementation edits whose
published signatures stay unchanged skip consumers. Shared contract edits check
the affected programs. Cold checking can take longer because shared types are
checked more than once; peak edit memory and parallel worktrees take priority.

Every local and CI typecheck runs through `scripts/tsc.ts`, which invokes
[tsrs](https://github.com/oxc-project/tsrs), a Rust port of TypeScript 7 that
reports the same diagnostics and emits the same declaration bytes. CI uses
the same compiler and Nx result cache as local
checks; there is no alternate compiler selector or second compiler pass.

The shared launcher uses one checker per process, including declaration
producers and imported tooling callers. Parallel checkers duplicate the type
graph; five worktrees need lower per-session memory more than one check needs
all the cores. Programs within `typecheck:web` still run sequentially; the full
workspace command permits two package checks at once. There is no machine-wide
queue or memory watchdog. Keep `--build` first when invoking the
launcher; it appends the checker policy after the caller's arguments.

Runtime Vite imports continue to load real source. Compiler paths alone redirect
HTTP handlers, SSR dispatch, server functions and middleware to the annotated
boundary declarations. The repository producer uses a schema-free native
Drizzle method projection behind an annotated repository-access boundary; the
remaining server checks that resolver's implementation. One source-only nominal
`Database` identity is shared across all programs. Canonical table definitions
stay single-owned: generated parent/child definitions and retained manual tables
and views are independent of global relational assembly. Both programs refer to
the same runtime table instances. Query helpers and list contracts remain below
composition; ordinary SQL repositories use the projected client and transaction
ports, while relational queries and workflows stay in the remaining server.
Each group retains its declarations' custom column-type imports, deduplicated
against the built-in column vocabulary.

The HTTP/reverse-boundary emitter uses `isolatedDeclarations`, `noResolve` and
`noCheck` for syntax-based production of annotated exports; the strict server
checks their bodies. Repositories instead use ordinary strict declaration emission,
including inferred table types, with `noEmitOnError`. Its persistent private emit
cache stays paired with incremental build-info; its output inventory records the
compiler revision so retries repair an interrupted emit. Successful builds publish a
complete declaration set, retaining unchanged bytes and timestamps; missing
cached output forces regeneration. The disposable annotated emitter keeps its
separate staging lifecycle. All caches and declarations belong to the worktree.

`tooling/typecheck-repositories.ts` owns the repository source roster and derives producer
roots, consumer exclusions and exact contract mappings from it. Boundary exports
must remain independent of implementation-derived registry types. Consumers
cross this boundary through the repository's `~/server/...` alias, which maps
to its emitted declaration. A relative import bypasses that mapping and pulls
repository implementation into the consumer; keep relative imports within the
same producer. The resolved
graph guard rejects repository source in its consumers, server composition in
repositories, browser routes/components in the server, unresolved generated-contract
imports, mixed nominal-handle copies and production source without a strict owner.

`pnpm typecheck` also retains the complete web check, including tests, tooling
and generator sources. This CLI split does not change which projects an editor's
language server opens; an editor-memory improvement requires separate evidence.

## Worktrees and test services

GitHub's Linux database lanes share a digest-pinned PostgreSQL 17/pgvector
image from Google's public Docker Hub mirror. The digest preserves the tested
image contents while avoiding Docker Hub's shared unauthenticated pull quota.
An image-pull failure is infrastructure setup, not a scenario result; inspect
the registry diagnostic before rerunning tests. Local test-service images and
native PostgreSQL installation remain owned by their existing runners.

- Fresh worktrees run `pnpm agent:setup`: a frozen install that restores or
  generates declaration outputs and installs Git hooks. It does not request
  WASM, so documentation and tooling work need no Rust toolchain. Gitignored env comes from
  [.worktreeinclude](../.worktreeinclude). Every `pnpm install` re-verifies
  `node_modules` (`optimisticRepeatInstall: false`), so rerunning it relinks a
  missing dependency instead of reporting "Already up to date".
- Amp orbs run [.agents/setup](../.agents/setup): Rust, wasm-pack and
  `pnpm agent:setup` on the image's Node, with Docker reachable without sudo.
  Start PostgreSQL/IntegreSQL with `docker compose -p cubby up -d --wait`.
- Rust builds share `~/.cache/cubby/cargo-target`.
  [scripts/ensure.ts](../scripts/ensure.ts) keys the WASM artifact on
  Cargo's resolved graph and file contents, so it never drifts silently.
  `pnpm typecheck`, `pnpm typecheck:web` and every web Vitest run call it, so
  a fresh worktree restores or builds the WASM on demand.
  Dev and production build entrypoints also ensure WASM before consuming it.
  The cached Nx target invokes the build directly and hashes Rust inputs and
  toolchain settings; unrelated root package-script changes do not invalidate it.
  Generation and WASM preparation always enter Nx; there is no separate local
  marker or stat-based cache deciding whether Nx runs.
  Keep new emitted paths in the root `generate.outputs` list in `project.json`.
  Verify that a cache hit restores a missing new output after changing that list.
  Use `node scripts/ensure.ts wasm` to prepare it explicitly through that cache;
  `pnpm wasm` forces the build command. Keep generated WASM checkout-local
  rather than copying or symlinking another worktree's output.
  The workspace `Cargo.lock` is tracked so worktrees share a key. Commit its
  churn after a parser bump.
- `pnpm dev` gives each checkout its own database and Worker namespace on free
  ports. Discover the session with `pnpm dev status --json`.
  Local development defaults to Apple `container` on macOS and Docker on Linux;
  select Docker on macOS with `CUBBY_DEV_SERVICES=docker`. See
  [local development](local-development.md#start-and-discover) for database and
  runtime ownership. Test services use their separate setting below.
- To sign in locally, click **Continue as local dev user** on the sign-in page,
  or open `<origin>/__dev/login?next=/some/path`. Both sign in the seeded
  synthetic dev user (`apps/web/tooling/dev/state.ts`) through better-auth.
  The route exists only in the local dev Worker entry and the button only in
  Vite dev builds; `check-client-bundle` rejects `/__dev/` in production output.
- Every worktree's database, browser tests and local development share one
  container IntegreSQL (`cubby-test-<config>-integresql`) on the same
  PostgreSQL as local development (`cubby-dev-pg`,
  `apps/web/tooling/dev-services/shared-postgres.ts`), started on first use and reused
  afterwards. A common migration-keyed base template feeds each checkout's
  namespaced test pools and the shared dev-corpus template.
  Offline browser journeys run the real provider-free derived frontier in
  their Node harness; queue peers still drop provider work. Fixture creators
  settle SQL projections before returning, serialized with that pump; fixtures
  that require populated Recipe totals compute them after their input writes
  settle. The corpus settles
  its initial SQL projections before becoming a cloneable template.
  Template election, setup failure cleanup, finalization and readiness belong
  to the existing IntegreSQL client. There is no Cubby initializer recovery,
  PID marker or successor-hash protocol. A killed initializer can leave its
  template pending: stop every client of that shared test service, then run
  `pnpm test:services:down` and restart through the managed runner. External
  service owners restart their own service. Do not discard a pending template
  while another client may still initialize it.
  Seeded fixture run records remain scoped by service URL and incarnation so
  cleanup cannot target another service's templates. Managed startup derives
  `CUBBY_TEMPLATE_SERVICE_ID` from both container start identities; external
  services supply a fresh shared ID after either service restarts. Process-birth
  checks protect live fixture runs; an unverifiable run is not cleanup authority.
  Local development clones that corpus to its stable `cubby_dev_*` name
  ([database lifetime](local-development.md#checkout-runtime)). One capped server (1.5 GB, 4 CPUs, durability off) replaces a
  second VM: Virtualization.framework guests never return freed memory to
  macOS. A test reset selects a fixed
  server session set, protects its registered clients across pools on the same
  actual host, port and database, and waits for those sockets to close. Unknown
  sessions fail before any termination: close and drain separate-process runtimes
  and borrowed clients before reset. Clients opened after server selection are
  outside that termination set. Expected termination handlers survive checkout
  until socket closure; other database errors remain failures. Workers, peers and Playwright
  listen on OS-assigned ports, so worktrees never collide. Startup runs under
  the machine-wide `/tmp/cubby-test-services.lock`, and each live run records
  itself in `/tmp/cubby-test-services/runs`. Record creation and command-group
  adoption use atomic rename; temporary files are not published records.
  Unreadable or invalid records remain intact and block startup/teardown before
  any service changes. Stop the record's clients and verify its owners are gone
  before manually repairing/removing it; automatic pruning requires a proven
  absent wrapper and command group. IntegreSQL a live run uses is never
  removed, an idle one of a superseded configuration (or an earlier revision's
  `cubby-test-<config>-postgres`) is removed, and idle IntegreSQL holding more
  than 100 databases is recreated with its `integresql_*` databases dropped.
  This is an idle-start recycling threshold, not a hard database cap: a managed
  run sharing the service defers it, and external mode bypasses it. Each distinct
  corpus hash (including explicit reseeds) retains its template and pool until
  that recycling/teardown; continuous sharing or externally owned services can
  accumulate beyond 100. Superseded templates are retained because another
  initializer/lease may still use them; external owners manage that lifetime.
  Apple container is the macOS default; Docker is the Linux default and can be
  selected on macOS with `CUBBY_DEV_SERVICES=docker`. Docker publishes IntegreSQL
  on an assigned loopback port; IntegreSQL and PostgreSQL communicate on the
  `cubby-local` Docker network.
  - `CUBBY_TEST_SERVICES=managed` is the local default.
    `CUBBY_TEST_SERVICES=external` connects to services already running; it
    does not start a container runtime. CI uses this mode with Docker services;
    `docker compose -p cubby up -d` also supports explicit external local runs. For another
    service, override `INTEGRESQL_URL`, `INTEGRESQL_DATABASE_HOST` and
    `INTEGRESQL_DATABASE_PORT` together.
  - A killed run's record is ignored once its PID is gone; a reused PID is
    conservatively treated as live.
- Parallelism overrides: `VITEST_MAX_WORKERS` for Vitest and Playwright's
  `--workers` flag (for example, `pnpm test:e2e --workers=2`).
- In dev, `await __jsProfile(5000)` in the browser console summarizes the
  hottest main-thread frames.

## Deployment (`apps/web` on Workers)

| File                                                              | Purpose                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| [apps/web/src/cf-server.ts](../apps/web/src/cf-server.ts)         | Platform Adapter; SDK wrapping, event handlers and DO exports |
| [apps/web/src/server/db.ts](../apps/web/src/server/db.ts)         | Request pools and scoped background pool cleanup              |
| [packages/wasm/workerd.js](../packages/wasm/workerd.js)           | Shared WASM initialization for production and test Workers    |
| [apps/web/cloudflare.config.ts](../apps/web/cloudflare.config.ts) | Bindings, vars, compat flags, secret names                    |

- **Hyperdrive.** Both bindings use one Neon origin. Account-side configuration
  and reconstruction live in [infrastructure](infrastructure.md#postgresql-and-hyperdrive);
  application read/freshness timing is owned by
  `apps/web/src/server/db/freshness/hyperdrive-cache-policy.ts`. Missing freshness state or a
  timeout falls back to strong reads.
- **Worker invocation ownership.** `server/worker/http.ts` owns explicit protocol
  dispatch, lazy request DB scope and response-body observation; `queue.ts` owns
  known-queue selection and awaited consumer completion; `scheduled.ts` owns cron
  selection and attempt-all failure propagation. Binding access is invocation-scoped
  with `withCfEnv`; authentication reads current bindings and caches only matching
  configuration values, including the current signing secret. It does not mutate
  `process.env` or retain a module-initialized auth policy. Response-independent work uses `afterResponse`, while required
  durable work remains in Jobs/Queues/DOs. Successful WebSocket upgrades are returned
  verbatim; ordinary responses, including socket refusals, receive correlation.
  Keep feature imports at their protocol/event owner. Dynamic syntax alone does not
  establish emitted size or startup savings.
- **Deployment identities.** `apps/web/worker-identity.json` owns queue names and cron
  expressions. Config reads its bytes to avoid making runtime modules Vite-denied
  configuration dependencies. Runtime/local adapters use `server/worker-identity.ts`.
  Keep resource IDs, binding declarations, placement and DO lifecycle in native config;
  generated Env inference remains authoritative. DO named exports preserve namespaces.
- **Background queue messages wake durable Jobs** on `cubby-background`. The minute
  recovery cron repairs missed wakes; domain consumers retain per-message ack/retry.
  Unknown transport queues are rejected before message parsing or DB access.
  - Daily maintenance is a `maintenance` Run (cron `scheduled`, the Problems
    card's Run now `manual`; one active pass at a time) whose steps
    (`domains/maintenance/service/maintenance-run.ts`) drain every backlog page
    by page: image-processing repair, EXIF/GPS, embeddings, stale recipe
    totals, abandoned uploads, Run housekeeping, original disposal, vector
    reconcile, calendar, mail discovery, then the image-processing backfill.
    The backfill runs each image's describe/identify/cutout jobs inline and
    pauses the Run at the AI budget until its window ends. An EXIF row whose
    original is gone (404) or whose extraction fails three times gets a
    terminal `Image.metadataOutcome` with its raw error, leaves the backlog
    and is listed on Problems; a step's Retry failed re-admits its failed refs.
    Failed image jobs are never re-queued silently.
  - App-open recovery (`requestCatchUp`) admits mail discovery and wakes due
    durable Jobs. Stopped work still requires explicit retry.
  - Financial generation publishes first-time rule recommendations in bounded
    batches, sharing charge admission reads and immutable Assessment inserts.
    Existing decisions, paid labels and suppressions retain the ordinary
    per-charge writer. Vendor-name resolution is shared only within a read-only
    preview page; committing spending reloads it. A failed batch falls back to individual admission;
    the post-commit settlement check finishes before acknowledging its items.
  - A financial Sweep's generation-step Retry failed re-admits only its retained
    charge references, in bounded pages through the current-evidence planner.
    It does not restart the population cursor or label healthy charges again.
    A publication committed before an after-commit failure is safely reused;
    stale pending advice is retired if that charge has since settled.
  - Image processing always accepts uploads and queued work; historical
    enabled/paused settings are ignored. Device availability and capability
    still determine which companion work can execute. Exceptional repair tools
    live on Problems; Settings contains connection diagnostics.
- Inventory and location valuation are computed on every read. Search
  projections are written inside the entity write transaction.
- Secrets are set with `wrangler secret put NAME --name cubby`. Production is the only deployed
  environment.

`build:cf` runs the Cloudflare Vite plugin v2 build. The native
`cloudflare.config.ts` supplies typed bindings, exports and triggers; the plugin
emits deployable Build Output under `apps/web/.cloudflare/output/v0/`, including
the Worker bundle and copied static assets. Deployment reuses this output with
`cf deploy --prebuilt --mode production`. The plugin writes directly into this
output tree; there is no separate `dist` bundle.

Keep runtime modules out of the deployment config import graph: the Cloudflare
Vite plugin denies config dependencies to the runtime loader. Read shared data
through relative URL file reads (as for Workflow declarations and platform
limits); the config loader also tracks `import.meta.resolve()` targets as
dependencies. Validate shared config data at the read boundary.

`Env` is inferred directly from the production configuration in
`worker-environment.d.ts`; local text values stay strings, and
`worker-bindings.ts` supplies isolated RPC contracts checked against live exports.
Vite's separate generated global types are disabled. `types:check` guards the
global declaration's importer graph against backend implementations.

Programmatic tests read the same Build Output through Cloudflare's public
reader and config converter. Wrangler remains behind `tooling/test-runtime.ts`
for its test harness, including Workflow introspection, Durable Object eviction
and structured logs; it also supplies live tail and interactive single-secret
operations and the name-based queue maintenance commands in the migration
runbook. It does not own builds, deployment or local dev startup.

## Auth and HTTP API

Better-Auth (`better-auth/tanstack-start`), with config in
`apps/web/src/lib/auth.ts` and `auth-client.ts`. In dev,
`/api/auth/reference` documents every auth endpoint.

- **API keys.** Create a `cubby_` key at `/account/api-keys` and send it as
  `x-api-key`. A key grants its owner's full access.
- **Native sign-in.** Native clients sign in with
  `Origin: cubby-mobile://` and send `Authorization: Bearer <token>`.
- **Scope.** HTTP carries exactly the contract members flagged `native:`
  (`apps/web/src/contracts/*.contract.ts`); the browser reaches every
  operation through the Start transport and agents through MCP.
- **Entity kernel.** Entity reads and writes are four POST routes with a
  free-form JSON body the server parses with the entity's own schema (an
  invalid body is a 400 with `validationIssues`): `/api/v1/entity/detail`
  (`{entity, shortcode}`, 404 when absent), `/api/v1/entity/list`
  (`{entity, filters, pagination: {pageIndex, pageSize}, sort?, groupBy?}`;
  `pageIndex` is 0-based, `sort` is `[{orderBy, direction}]`),
  `/api/v1/entity/mutate` (`{action: "create" | "update" | "delete", …}`) and
  `/api/v1/entity/timeline`. Per-entity filter names, kinds and actions for
  native clients are generated into CubbyKit's `entity-kernel.json`.
- **Operations.** Other operations use `GET` (flat input) or `POST` (structured
  input or mutation) on `/api/v1/{domain}/{op}`. Success bodies are the output
  itself; errors are `ApiError`. Flat GET filters repeat the key
  (`tag=a&tag=b`) and nothing is JSON-encoded.
- **Native contract.** The Swift-only interface is derived directly from the declarations
  and wire projections by `apps/web/generator/http-api/native-contract.ts`. `pnpm generate`
  emits plain Swift models, payload-returning methods and one route table; URLSession
  transport and representation rules are owned by the
  [native pipeline](../apps/apple/CubbyKit/Sources/CubbyAPI/README.md).
- **Test client.** `createCubbyClient({ baseUrl, apiKey? })` in
  `apps/web/tests/e2e/support/http-api-client.ts` wraps the generated ts-rest router
  `apps/web/src/lib/generated/http-contract.gen.ts`.
- **After changes.** When contracts, declarations or schemas change, run
  `pnpm generate`. Wire schemas come from `toWire`
  (`apps/web/src/lib/http-api/wire.ts`).

The MCP endpoint `/api/mcp` is an OAuth 2.1 resource server; clients enrol
through dynamic client registration. Tools return structured data only; the
calling agent presents choices such as `usda_food.search` candidates in its own
conversation. MCP operating patterns are in [MCP](agents/mcp.md).

The MCP usage dashboard service receives its catalog and aggregate ports from
the browser operation adapter. Only the adapter loads the production MCP server;
unit checks of usage aggregation do not initialize the complete tool runtime.
