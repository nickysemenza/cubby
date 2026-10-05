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
- USDA data comes from the `usda-api` Worker through the ts-rest contract
  `@cubby/usda/contract`. Its client is `apps/web/src/server/clients/usda.ts`.
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

## Commands

| Command                                                            | What it does                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `pnpm dev`                                                         | Local workerd HMR session with isolated persistent resources        |
| `pnpm build`                                                       | Build the production Worker bundles                                 |
| `pnpm check`                                                       | Generate, TypeScript, lint, format, Knip                            |
| `pnpm check:all`                                                   | `check` plus Worker/OpenAPI, script tests and security validation   |
| `pnpm generate` / `pnpm check:clean`                               | Regenerate entity/contract/OpenAPI artifacts, then prove them clean |
| `pnpm typecheck` · `lint` · `lint:fix` · `format` · `format:check` | Individual checks                                                   |
| `pnpm test`                                                        | Fast unit, UI, contract and auxiliary-package tests                 |
| `pnpm test:postgres`                                               | Authoritative PostgreSQL contracts                                  |
| `pnpm test:e2e`                                                    | PostgreSQL-backed Playwright tests                                  |
| `pnpm test:all`                                                    | Fast tests, then PostgreSQL, then Playwright (sequential)           |
| `pnpm test:e2e:local`                                              | Every local-only E2E lane (headless, photo, wardrobe, simulator)    |
| `pnpm test:e2e:sim [-- --headless\|--watch\|--video\|--layout]`    | iOS simulator or headless CLI journey against a disposable DB       |
| `pnpm --filter @cubby/web test:e2e:watch`                          | Warm services + `vite build --watch` + Playwright `--ui`            |
| `pnpm test:services:down`                                          | Remove warm test containers                                         |
| `pnpm db:generate` / `pnpm db:check`                               | Generate a migration from `schema.ts` / prove migrations match it   |
| `pnpm --filter @cubby/web db:migrate -- --target=production`       | Apply migrations; needs `PRODUCTION_DIRECT_DATABASE_URL`            |
| `pnpm deploy:all`                                                  | Deploy web, purchase-agent, then usda-api                           |
| `pnpm wasm`                                                        | Rebuild `@cubby/recipebridge` from Rust, uncached                   |
| `pnpm apple <cli\|mac\|ios\|sim\|gen\|test>`                       | Native app products                                                 |

Test suffixes: `*.unit.test.ts` (Vitest), `*.integration.test.ts` (PostgreSQL
contracts, Vitest), `*.spec.ts` (Playwright). Which tier to use is set by the
[validation policy](agents/validation.md) and [test tiers](agents/validation-tests.md).
CI scoping is in [CI](ci.md). Provider resources and secrets are in
[infrastructure](infrastructure.md). Pinned dependency exceptions are in
[dependency exceptions](dependency-exceptions.md).

The `usda-api` D1 database does not use the web migration
workflow. Apply remote D1 migrations before deploying code that depends on
them.

## Worktrees and test services

- Fresh worktrees run `pnpm agent:setup`: a frozen install, then a WASM build
  restored from the shared Nx cache. Gitignored env comes from
  [.worktreeinclude](../.worktreeinclude). Every `pnpm install` re-verifies
  `node_modules` (`optimisticRepeatInstall: false`), so rerunning it relinks a
  missing dependency instead of reporting "Already up to date".
- Rust builds share `~/.cache/cubby/cargo-target`.
  [scripts/ensure-wasm.ts](../scripts/ensure-wasm.ts) keys the WASM artifact on
  Cargo's resolved graph and file contents, so it never drifts silently.
  The workspace `Cargo.lock` is tracked so worktrees share a key. Commit its
  churn after a parser bump.
- `pnpm dev` gives each checkout its own database and Worker namespace on free
  ports. Discover the session with `pnpm dev:status -- --json`.
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
  - After a SIGKILL, find leftovers with `container list --all`.
- Parallelism overrides: `VITEST_MAX_WORKERS` and `CUBBY_E2E_WORKERS`.
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
- **Docs.** `/api/v1/docs` (Scalar) and `/api/v1/openapi.json` (OpenAPI 3.1).
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
