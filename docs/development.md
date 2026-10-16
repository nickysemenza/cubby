# Development reference

Architecture, commands, testing, deployment and the HTTP API. For starting and
troubleshooting a dev session, see [local development](local-development.md).
For what Cubby is and how its entities fit together, see the
[README](../README.md).

## Architecture

```
TanStack Start  →  Entity Kernel  →  Repo  →  Database
Start workflows ───────────────↗
MCP / jobs      ───────────────↗
JSONL routes    →  cancellable workflow streams
```

- Entity declarations in `packages/schemas/src/entity-definitions/*.entity.ts`
  compile into the manifest, schema bindings, browser roster, filter catalog,
  kernel capabilities and contract cases. `pnpm generate` rejects invalid
  declarations, and `pnpm check:clean` proves generation leaves the tree
  unchanged. New-entity work starts at [entities](entities.md).
- `executeEntity` is the baseline CRUD, filter, search and relation interface.
  Every other operation is a contract in `apps/web/src/contracts/`, implemented
  once in a domain's `operations` module
  (`src/server/domains/<domain>/operations.server.ts` or `operations/*.server.ts`).
  The browser, HTTP API and MCP are adapters over it.
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
  `wasm` from `~/lib/wasm` (sync) on the client and `wasmServer` (async) on the
  server. Conversions chain through a product's unit mappings, e.g.
  `2 cups → $5.00 → 333g`.
- `pnpm wasm` prepares three packages through the shared
  [artifact preparation entrypoint](../scripts/ensure.ts) into
  `packages/wasm`. The Worker and Vitest load the full build, `worker/`. The browser
  loads `browser/`, built without the Worker-only `html` and `ai-usage`
  features (`compact_browser_page`, `parse_scraped_recipe`,
  `gateway_call_usage`). Only the cookbook import loads
  `@cubby/recipebridge/cookbook` (the `recipebridge/cookbook` crate). Put a new
  Worker-only export behind one of those features; browser code must not call
  it, which `wasm-browser-exports.unit.test.ts` enforces, and
  `check-client-bundle.ts` checks each package lands in the right bundle.
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
  integrations and live evaluations use the separate `cubby-testing`
  gateway so they cannot consume production's admission budget. [ChatGPT setup](runbooks/chatgpt-plan.md) explains
  local authorization, the read-only account model catalog, limitations, and
  how each `AiUsage` row records its transport.

The interactive `/ai` Smoke tests tab covers every active AI feature. Mailbox
triage and relevance probes use synthetic original mail; research source support
compares a proposed fact with a synthetic retained catalog observation. These
probes share production request builders and feature/subscription settings;
durable research allowance admission is verified by its PostgreSQL and Worker
contracts separately.

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
3. Set `USDA_ACTIVE_RELEASE` in `apps/web/wrangler.jsonc` and deploy. Reads
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

## Worktrees and test services

GitHub's Linux database lanes share a digest-pinned PostgreSQL 17/pgvector
image from Google's public Docker Hub mirror. The digest preserves the tested
image contents while avoiding Docker Hub's shared unauthenticated pull quota.
An image-pull failure is infrastructure setup, not a scenario result; inspect
the registry diagnostic before rerunning tests. Local test-service images and
native PostgreSQL installation remain owned by their existing runners.

- Fresh worktrees run `pnpm agent:setup`: a frozen install, then a WASM build
  restored from the shared Nx cache. Gitignored env comes from
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
  `scripts/lib/shared-postgres.ts`), started on first use and reused
  afterwards. A common migration-keyed base template feeds each checkout's
  namespaced test pools and the shared dev-corpus template.
  All template layers use IntegreSQL's initializer election without a template
  lock. Recovery supports one Mac or one CI runner: all clients must share the
  same host temporary marker directory and service incarnation. Separate machines,
  containers with separate temp directories, and unmarked pending owners fail closed;
  there is no cross-host recovery. Pending records under `cubby-template-initializers`
  are keyed by service URL, incarnation and hash and record host, PID and a
  versioned process birth identity read with `TZ=UTC LC_ALL=C`. A live or
  unverifiable owner is never discarded. Recovery uses the shared
  [tri-state process-liveness contract](local-development.md#checkout-runtime);
  unknown ownership reports the PID and resolution command, while live owners
  wait at most two minutes.
  A proven-dead owner redirects to a deterministic successor hash. Only newly
  created redirects consume the eight-interruption budget; established redirects
  may be traversed across any number of past interruptions within the deadline.
  Concurrent recoverers discard only the abandoned hash through IntegreSQL's API.
  A kill before the owner record exists times out rather than guessing ownership.
  Successful finalization removes its pending record. Managed startup derives
  `CUBBY_TEMPLATE_SERVICE_ID` from both containers' start identities and retires
  named directories from previous incarnations; recycling and teardown remove
  named incarnation directories. Legacy-layout marker files and unverified scopes
  remain untouched because they cannot prove a gone service incarnation and an
  older live initializer still needs its pending file for finalization. External
  services must provide a shared, fresh ID whenever either
  service restarts (CI uses its fresh job's identity). Without it, initialization
  and finalized-template reuse work, but pending-owner recovery fails closed.
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
  itself in `/tmp/cubby-test-services/runs`: IntegreSQL a live run uses is never
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

| File                                                                          | Purpose                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------- |
| [apps/web/src/cf-server.ts](../apps/web/src/cf-server.ts)                     | Worker entry; wraps requests in `withRequestDb()` |
| [apps/web/src/server/db.ts](../apps/web/src/server/db.ts)                     | Per-request `pg.Pool`                             |
| [apps/web/src/lib/recipebridge-cf.ts](../apps/web/src/lib/recipebridge-cf.ts) | WASM via `?init` (Workers SSR)                    |
| [apps/web/wrangler.jsonc](../apps/web/wrangler.jsonc)                         | Bindings, vars, compat flags, secret names        |

- **Hyperdrive.** Both bindings use one Neon origin. Account-side configuration
  and reconstruction live in [infrastructure](infrastructure.md#postgresql-and-hyperdrive);
  application read/freshness timing is owned by
  `apps/web/src/server/db/freshness/hyperdrive-cache-policy.ts`. Missing freshness state or a
  timeout falls back to strong reads.
- **Background tasks are self-contained queue messages** on
  `cubby-background`. There is no execution table and no dead-letter queue.
  - Every handler re-checks its row's own freshness marker, so redelivery is a
    no-op.
  - A lost wakeup is repaired on read, or with the "Settle now" button on the
    Problems page.
  - The daily cron only _asserts_ that the awaiting counts are zero.
- Inventory and location valuation are computed on every read. Search
  projections are written inside the entity write transaction.
- Secrets are set with `wrangler secret put`. Production is the only deployed
  environment.

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
- **Document.** The OpenAPI 3.1 document exists only for the Apple client
  (`apps/apple/CubbyKit/Sources/CubbyAPI/openapi.json`, gitignored, written by
  `pnpm generate`). Component names come from `@cubby/schemas` exports or an
  explicit `.meta({ id })`.
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
