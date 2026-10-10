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
  once in `src/server/operations/<domain>.server.ts`. The browser, HTTP API and
  MCP are adapters over it.
- Services own workflows and external enrichment. Repositories own
  transactions, invariants and entity-specific SQL. `Database` is a
  request-scoped handle, and repository helpers resolve its Drizzle client.
- Unit conversion uses `@cubby/recipebridge`, which wraps Rust
  [ingredient-parser](https://github.com/nickysemenza/ingredient-parser). Call
  `wasm` from `~/lib/wasm` (sync) on the client and `wasmServer` (async) on the
  server. Conversions chain through a product's unit mappings, e.g.
  `2 cups → $5.00 → 333g`.
- [scripts/build-wasm.sh](../scripts/build-wasm.sh) builds three packages into
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
- Purchase imports run in the web Worker, which binds both the purchase
  agent's and the browser bridge's Durable Objects, and in a Mac browser. The
  map of queue events, Run services and owning files is
  [`apps/web/src/server/purchase-import/README.md`](../apps/web/src/server/purchase-import/README.md).
- OpenAI Responses calls use the household's ChatGPT plan when connected in
  Settings, retaining the declared Luna/Sol choices. `CHATGPT_PLAN` owns OAuth
  credentials and serializes rotating refreshes. Other providers and embeddings
  use the existing AI Gateway. [ChatGPT setup](runbooks/chatgpt-plan.md) explains
  local authorization, the read-only account model catalog, limitations, and
  how each `AiUsage` row records its transport.

The interactive `/ai-smoke-test` catalog covers every active AI feature. Mailbox
triage and relevance probes use synthetic original mail; research source support
compares a proposed fact with a synthetic retained catalog observation. These
probes share production request builders and feature/subscription settings;
durable research allowance admission is verified by its PostgreSQL and Worker
contracts separately.

## Commands

| Command                                                            | What it does                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `pnpm dev`                                                         | Local workerd HMR session with isolated persistent resources                |
| `pnpm build`                                                       | Build the production Worker bundles                                         |
| `pnpm check`                                                       | Generate, TypeScript, lint, format, Knip                                    |
| `pnpm check:all`                                                   | `check` plus Worker/OpenAPI, script tests and security validation           |
| `pnpm generate` / `pnpm check:clean`                               | Regenerate entity/contract/OpenAPI artifacts, then prove them clean         |
| `pnpm typecheck` · `lint` · `lint:fix` · `format` · `format:check` | Individual checks                                                           |
| `pnpm test`                                                        | Fast unit, UI, contract and auxiliary-package tests                         |
| `pnpm test:postgres`                                               | Authoritative PostgreSQL contracts                                          |
| `pnpm test:e2e`                                                    | PostgreSQL-backed Playwright tests                                          |
| `pnpm test:all`                                                    | Fast tests, then PostgreSQL, then Playwright (sequential)                   |
| `pnpm test:e2e:local`                                              | Headless + simulator smoke; choose lanes or `--all` for extended acceptance |
| `pnpm test:e2e:sim [-- --headless\|--watch\|--video\|--layout]`    | iOS simulator or headless CLI journey against a disposable DB               |
| `pnpm --filter @cubby/web test:e2e:watch`                          | Warm services + `vite build --watch` + Playwright `--ui`                    |
| `pnpm test:services:down`                                          | Remove warm test containers                                                 |
| `pnpm test:services:prune`                                         | Recover abandoned disposable test containers                                |
| `pnpm db:generate` / `pnpm db:check`                               | Generate a migration from `schema.ts` / prove migrations match it           |
| `pnpm --filter @cubby/web db:migrate --target=production`          | Apply migrations; needs `PRODUCTION_DIRECT_DATABASE_URL`                    |
| `pnpm deploy:all`                                                  | Deploy web and purchase-agent                                               |
| `pnpm wasm`                                                        | Rebuild the `@cubby/recipebridge` packages from Rust, uncached              |
| `pnpm apple <cli\|mac\|ios\|sim\|gen\|test>`                       | Native app products                                                         |

Test suffixes: `*.unit.test.ts` (Vitest), `*.integration.test.ts` (PostgreSQL
contracts, Vitest), `*.spec.ts` (Playwright). Which tier to use is set by the
[validation policy](agents/validation.md) and [test tiers](agents/validation-tests.md).
CI scoping is in [CI](ci.md). Provider resources and secrets are in
[infrastructure](infrastructure.md). Pinned dependency exceptions are in
[dependency exceptions](dependency-exceptions.md).

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
new release id or `pnpm dev:reset`, because a loaded release object keeps its
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
  [scripts/ensure-wasm.ts](../scripts/ensure-wasm.ts) keys the WASM artifact on
  Cargo's resolved graph and file contents, so it never drifts silently.
  The workspace `Cargo.lock` is tracked so worktrees share a key. Commit its
  churn after a parser bump.
- `pnpm dev` gives each checkout its own database and Worker namespace on free
  ports. Discover the session with `pnpm dev:status -- --json`.
  Local development defaults to Apple `container` on macOS and Docker on Linux;
  select Docker on macOS with `CUBBY_DEV_SERVICES=docker`. See
  [local development](local-development.md#start-and-discover) for volume and
  runtime ownership. Test services use their separate setting below.
- To sign in locally, click **Continue as local dev user** on the sign-in page,
  or open `<origin>/__dev/login?next=/some/path`. Both sign in the seeded
  synthetic dev user (`apps/web/tooling/dev/state.ts`) through better-auth.
  The route exists only in the local dev Worker entry and the button only in
  Vite dev builds; `check-client-bundle` rejects `/__dev/` in production output.
- On macOS, each database or browser test command owns a disposable Apple
  `container` PostgreSQL/IntegreSQL pair, cleaned up on exit.
  - `CUBBY_TEST_SERVICES=warm` reuses fixed-name containers.
  - `CUBBY_TEST_SERVICES=external` connects to services already running; it
    does not start a container runtime. Linux and CI use this mode with Docker
    services (`docker compose -p cubby up -d` for local Linux setup). For another
    service, override `INTEGRESQL_URL`, `INTEGRESQL_DATABASE_HOST` and
    `INTEGRESQL_DATABASE_PORT` together.
  - SIGKILL cannot execute exit cleanup. The next managed run recovers abandoned
    per-run services, or run `pnpm test:services:prune`. Recovery requires a dead
    owner PID, the expected image and no mounts; it preserves active runs,
    `cubby-dev-pg`, warm services and unrelated containers. A reused PID is
    conservatively treated as live, so inspect remaining containers manually.
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

- **Hyperdrive bindings.** There are two, both pointing at the same Neon
  origin.
  - `HYPERDRIVE` is the strong-read path, with up to 5 connections per
    request.
  - `HYPERDRIVE_CACHED` serves cache-eligible reads: 60 s cached plus 15 s
    stale-while-revalidate, with 1 connection.
  - After a household write, reads are strong for 90 s. The
    `DatabaseFreshnessDurableObject` holds the last-write timestamp, and a
    missing binding or a timeout falls back to strong reads. Timings are in
    `src/lib/hyperdrive-cache-policy.ts`.
  - Hyperdrive caching settings are account state; inspect them with
    `wrangler hyperdrive get`.
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

### Purchase research schema cutover

The replacement changes stored research contracts and native browser protocol
in place. Before production migration approval, retain immutable builds for
both the replacement and a current-main-compatible quiescence build carrying
the maintenance guards. Keep the same Durable Object namespaces and storage.
The populated-history migration regression runs the complete journal twice;
its preservation checks are a prerequisite, not production readback evidence.

1. Pause delivery for `cubby-background`, `cubby-telemetry` and
   `cubby-purchase-agent`; record pending and in-flight batches. Enable
   `MAINTENANCE_MODE=true` and pause live Workflow instances, including any
   search-index repair writer. Wait for actual paused status.
2. Deploy the quiescence build fully. Verify affected coordinator/broker
   instances have stopped: in-flight model/tool calls and database transactions
   must settle or stop. A deployment request or deleting an alarm is not that
   acknowledgement. Coordinator callbacks defer/refuse before database access,
   broker sockets close without result ACKs, and the Mac retains replay bytes.
3. Terminate obsolete Gmail Workflows without rollback or history deletion.
   Leave compatible work paused. Wait out the last possible direct R2 upload
   grant (300 seconds for legacy Run evidence), accounting for uploads already
   started and any other issued upload grants before declaring objects stable.
4. After approval of `0025_purchase_research` and the preservation/readback plan,
   apply this single rewrite migration with all holds in place. Interrupted legacy research becomes
   `needs_review`; retain its inputs, targets, operations and diagnostics.
   Read back signed money totals, stock, photos, associations and decisions,
   plus the migration/schema state.
5. Deploy the exact replacement revision while maintenance remains enabled.
   Verify compatible native clients before resuming their work. TestFlight
   continues publishing from main; branch iteration uses a verified development
   client, and the minimum-version fence keeps older clients from writing until
   their main release is installed. Verify Worker/DO revisions and reconcile retained browser
   results against interrupted Runs; they must not reopen old conversations.
6. Reopen HTTP, resume queues, and admit only approved fresh research. Resume
   separately paused compatible Workflows deliberately. Terminated legacy
   instances stay terminated; historical full-mail backfill remains disabled
   until its measured spending cap is approved.

Queues are paused externally because ordinary retries consume their bounded
retry allowance. Maintenance guards supplement those controls; they do not
replace quiescence evidence or establish erasure of unknown legacy client caches.

## Auth and HTTP API

Better-Auth (`better-auth/tanstack-start`), with config in
`apps/web/src/lib/auth.ts` and `auth-client.ts`. In dev,
`/api/auth/reference` documents every auth endpoint.

- **API keys.** Create a `cubby_` key at `/account/api-keys` and send it as
  `x-api-key`. A key grants its owner's full access.
- **Native sign-in.** Native clients sign in with
  `Origin: cubby-mobile://` and send `Authorization: Bearer <token>`.
- **Resource routes.** Every entity gets `GET/POST /api/v1/<entity>` and
  `GET/PATCH/DELETE /api/v1/<entity>/{id}`.
- **Lists.** `page` is 1-based; `pageSize` defaults to 10, max 500; `sort`
  takes up to 3 comma-separated fields with `-` for descending. Filters are
  plain query parameters, and unknown ones return 400.
- **Operations.** Other operations use `GET` (flat input) or `POST` (structured
  input or mutation) on `/api/v1/{domain}/{op}`. Success bodies are the output
  itself; errors are `ApiError`.
- **Docs.** `/api/v1/docs` (Scalar) and `/api/v1/openapi.json` (OpenAPI 3.1, the generated document emitted as a static asset by `tooling/worker-static-assets.ts`; no Worker code runs).
  The Apple app generates its client from the committed document.
- **Opting out.** `http: false` on a contract member excludes it from HTTP
  (streams and the generic entity union operations).
- **Filter encoding.** Lists repeat the key (`tag=a&tag=b`), object-valued
  filters flatten to prefixed scalars, and nothing is JSON-encoded. Component
  names come from `@cubby/schemas` exports or an explicit `.meta({ id })`.
- **Test client.** `createCubbyClient({ baseUrl, apiKey? })` in
  `apps/web/tests/e2e/http-api-client.ts` wraps the generated ts-rest router
  `apps/web/src/lib/generated/http-contract.gen.ts`.
- **After changes.** When contracts, declarations or schemas change, run
  `pnpm generate`. Wire schemas come from `toWire`
  (`apps/web/src/lib/http-api/wire.ts`).

The MCP endpoint `/api/mcp` is an OAuth 2.1 resource server; clients enrol
through dynamic client registration. [apps/mcp-apps](../apps/mcp-apps) builds
self-contained HTML UIs that the server inlines as `ui://` resources, currently
only for `usda_food.search`. Run `pnpm --filter @cubby/mcp-apps dev` for a
local host harness. MCP operating patterns are in [MCP](agents/mcp.md).
