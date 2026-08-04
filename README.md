# 🥡 cubby

Recipe database and home inventory database, tied together. A personal pantry-and-cooking system: track what you own, where it lives, what it cost, and what you can cook with it.

## 🎯 Why Cubby

Cubby is a personal system — built for my own household, not a product for strangers. Its north-star is the **recipe ↔ inventory tie**: knowing what I can actually cook from what I physically own, where it lives, and what it costs. Most tools do recipes *or* a pantry list; Cubby joins the two, so *"what can I make tonight, and what would it cost?"* becomes a query instead of a guess.

It's three things at once: an earnest daily-use home utility, a playground for a modern stack (TanStack Start, Cloudflare Workers, Rust/WASM, agentic AI), and a place to hold a high engineering bar on something I actually use.

**Cubby is _not_:**

- A **multi-tenant SaaS** — no public sign-ups, billing, or tenant-isolation work
- **Cross-platform** — mobile is iOS-only by design
- A **social app** — no feeds, public recipe sharing, or community
- A **commerce tool** — no in-app buying, ordering, or cross-store price-shopping

### Tenets

Standing decisions that keep scope honest. A backlog item that contradicts one of these is rejected, not deferred.

1. **Inventory is a ballpark, not a ledger.** For kitchen ingredients especially, a count is a stale-tolerant estimate — enough to answer *"do I have enough flour?"*, never precise enough to drive automatic math. Truth is restored by a deliberate [recount](docs/inventory-audit.md), never inferred from activity. **Nothing decrements inventory as a side effect** — there is no cook-a-recipe → deduct-the-ingredients flow, and there won't be. Consumption is always an explicit human act.
2. **`fdc_id` belongs to the product, not the ingredient.** A USDA link describes a specific purchasable thing, not the abstract "flour". Ingredient nutrition resolves through the product (`ingredient → product → fdc_id`) — always one hop away, on purpose. Don't add a per-ingredient USDA column to shorten the hop.
3. **Rare and interactive work stays interactive.** Cookbook/EPUB import runs a few times a year with a human watching; it needs no queue, retries, or DLQ. The background queue is for work that is frequent, unattended, or slow enough to break a request (embeddings, valuation, recompute) — not for making rare work look industrial.
4. **One household, trusted users.** Cubby serves a tiny, mutually trusted household user set, not isolated tenants. Authenticated household users may see household-wide operational data, including user and client attribution in MCP analytics. Every trade-off resolves toward the household's taste: no multi-user coordination, no restore/undo, no reservations or locking. Speed and recoverability beat correctness ceremony.
5. **All money lives on `Expense`.** Spend is `SUM(expense.cost)`, always — the `Vendor ──< Purchase ──< Expense` header carries *identity* (who, which order, which date) and at most a `statedTotal` that is **never summed into spend**. `statedTotal` is a soft reconciliation cue whose mismatch is frequently correct, so nothing may reject a write over it or back-compute a cost from it. Don't propose a second place money is stored or a rollup that adds header totals to line totals.

## ✨ Capabilities

**Inventory**
- Add/edit/move inventory items across hierarchical locations
- Barcode scan for quick capture (mobile-optimized)
- Bulk edit and move
- Gallery, table, and visualization (treemap, sunburst) views
- Phone-first recount/reconcile pass — the deliberate act that refreshes the ballpark (see [docs/inventory-audit.md](docs/inventory-audit.md))

**Products**
- Specific items (UPC, manufacturer, price, nutrition) or `misc:` placeholders
- Multi-unit mappings (volume ↔ weight ↔ price) for cross-unit conversions
- Optional link to an ingredient and to a USDA food entry

**Recipes**
- Multi-section recipes with nested ingredients
- Ingredients can be other recipes (composition)
- Side-by-side recipe comparison
- Cost rollups via product unit mappings
- Prep-sheet, nested (spec), ingredient × component matrix, and AI-assembled step-flow views, plus a print/export route
- Client-side scaling (multiplier / target weight / anchor ingredient)

**Cookbooks**
- Import a cookbook from an EPUB — chapters chunked and assembled into recipes (client-side WASM extraction, server-side LLM proxy)
- Recipes keep a `recipeSource` pointer back to the cookbook they came from

**Meals**
- Plan recipes onto a shared month calendar (plus a table view), scaled per meal
- Shopping list — aggregated need vs. on-hand inventory, with a per-meal breakdown (display-only; see [Tenets](#tenets))
- Suggestions — *"what can I make tonight?"* from what's on hand

**Planning calendar**
- One month view for meals, due tasks, expenses, and multi-day project spans
- Source and project-kind filters, date drawers with daily totals, and quick-add flows
- Drag-to-reschedule for meals, tasks, and planned expenses; actual expenses and project spans stay read-only

**USDA**
- Full USDA FoodData Central database loaded into a sibling service
- Browse, search, and link products by UPC or NDB code

**Locations**
- Tree structure (house → room → shelf → bin)
- Drag-drop arrange surface (tree + Miller-column board) for reparenting locations and moving items
- Interactive graph, treemap, sunburst views
- Printable QR-code shortcode labels

**Images**
- S3/R2-backed image upload with presigned URLs
- Linked to products, locations, recipes, projects, or a purchase (its invoice/receipt)

**Project Tracker**
- Household projects, tasks, and expenses (the spend ledger) — migrated from Notion into first-class entities
- Vendor roster and per-transaction `Purchase` records: order id, purchase date, stated total, and invoice PDF, with split/link/merge operations over the Expenses
- Typed Expense receipt roles (`principal`, tax, shipping, discount, fee, tip, other adjustment) that keep all money in `SUM(Expense.cost)` while excluding ancillary rows from merchandise/category analytics
- `ProjectToolUsage` — a durable, deliberately coarse edge recording that a reusable tool or software Product was used on a project, for tool lifetime cost / cost-per-project-use rollups
- Blocked-by dependency edges between projects and between tasks
- Dashboard with overview/charts/data/gallery views (spending, timelines, task heatmaps, dependency graph)
- Detail pages with full inline editing, markdown notes, and image galleries
- First-class inline links/hovercards, global + semantic search, full MCP CRUD

**Financial accounts & transactions**
- `FinancialAccount ──< FinancialTransaction` — a settlement evidence layer separate from spend: statement activity (pending charges, split tender, installments, refunds), with an optional link from a Transaction to the Purchase it settles
- Never changes spend — `Expense.cost` remains the sole spend source; reconciliation compares linked non-void transactions against live Expense lines as `unknown` / `pending` / `match` / `mismatch`
- Client-parsed Monarch statement preview → selective creation, never a CSV upload path

**Wishlist**
- A simple wanted-items list (name, notes, optional price, acquired toggle) for tracking things not yet owned, independent of inventory or projects

**Analytics**
- Donut, treemap, sunburst, and network visualizations across products, inventory, and ingredients
- Category audits + data-problem detection

**Auth & Audit**
- Better-Auth sign-up/login with API keys
- Activity log across all entities
- Soft delete on all major entities (no restore — by design)

**Mobile (PWA, iOS)**
- Installable PWA with splash screens
- Touch-friendly cards and immersive barcode scanner
- App-shell offline fallback with precached styles, fonts, and recipe WASM
- *A true offline mutation queue is deliberately deferred — the app shell works offline, writes need the network*

## 🧱 Tech Stack

- **App:** TanStack Start (Router + Server) · React · TailwindCSS · shadcn/ui
- **API:** tRPC + TanStack Query
- **Data:** Drizzle ORM · PostgreSQL · Hyperdrive (edge pool)
- **Auth:** Better-Auth (`@daveyplate/better-auth-ui` for routed UI)
- **Edge:** Cloudflare Workers + Wrangler
- **WASM:** `@cubby/recipebridge` wraps Rust [ingredient-parser](https://github.com/nickysemenza/ingredient-parser)
- **Storage:** Cloudflare R2 (S3-compatible) for images
- **Charts:** Nivo (bar, pie, treemap, sunburst, calendar, line) + d3-force, d3-hierarchy
- **Tooling:** Biome (lint + format) · Vitest (unit/integration) · Playwright (E2E) · IntegresQL (test DB isolation)
- **Observability:** OpenTelemetry → Jaeger (dev only) · Sentry

## 📦 Monorepo Layout

### Apps (deployed)

| Path | Package | Role | Runtime | Deploys to |
|---|---|---|---|---|
| [apps/web](apps/web) | `@cubby/web` | Main app — TanStack Start + tRPC + Drizzle | Cloudflare Workers | Worker `cubby` · DB via **Hyperdrive** → Postgres |
| [apps/upc-lookup](apps/upc-lookup) | `@cubby/upc-lookup` | UPC barcode lookup API — Hono + D1 | Cloudflare Workers | Worker `upc-lookup` · <https://upc-lookup.nicky.workers.dev> |
| [apps/usda-api](apps/usda-api) | `@cubby/usda-api` | USDA FoodData Central API — Hono + D1/R2 bundles | Cloudflare Workers | Worker `usda-api` · <https://usda-api.nicky.workers.dev> · D1 search index + R2 NDJSON payload bundles |

### Packages (internal, not deployed)

| Path | Package | Role | Consumed by |
|---|---|---|---|
| [packages/wasm](packages/wasm) | `@cubby/recipebridge` | WASM bindings — built from `recipebridge/` Rust source via `pnpm run wasm` | `web` |
| [packages/upc-contract](packages/upc-contract) | `@cubby/upc-contract` | Shared UPC request/response transport contract | `web`, `upc-lookup` |
| [packages/usda-contract](packages/usda-contract) | `@cubby/usda-contract` | ts-rest endpoint contract for the USDA API | `web`, `usda-api` |
| [packages/usda-schemas](packages/usda-schemas) | `@cubby/usda-schemas` | Shared Zod schemas for USDA entities | `web`, `usda-api` |
| [packages/schemas](packages/schemas) | `@cubby/schemas` | Cross-app Zod schemas | `web` |
| [packages/shared](packages/shared) | `@cubby/shared` | Shared utilities, including guarded external fetches | `web`, `upc-lookup` |
| [packages/worker-tracing](packages/worker-tracing) | `@cubby/worker-tracing` | Cloudflare Worker tracing/Sentry bootstrap | all three Workers |
| [packages/design-tokens](packages/design-tokens) | `@cubby/design-tokens` | Shared brand CSS (palette, type stacks) | `web`, `mcp-apps` |
| [apps/mcp-apps](apps/mcp-apps) | `@cubby/mcp-apps` | Interactive MCP-hosted UIs — its own build target, inlined into `web`'s server rather than deployed on its own; see [MCP Apps](#mcp-apps-interactive-uis-in-the-conversation) | `web` (inlined at build) |
| [recipebridge/](recipebridge) | (Rust source) | Source for the ingredient-parser WASM shim | Built into `packages/wasm` |

## 🏗️ Architecture

Request flow:

```
Router (tRPC)  →  Service (optional, enrichment only)  →  Repo (data access)  →  Database
```

- Routers use the CRUD factory (`createEntityCrudProcedures` from `crud-factory.ts`) for standard CRUD operations.
- Services exist only when entities need enrichment (e.g., USDA food data). Otherwise routers call repos directly.
- The `Database` type is **opaque** — only repos can call `getDb(db)` to unwrap it. This enforces the layered architecture at the type level.

See [CLAUDE.md](CLAUDE.md) for the prescriptive rules (branded IDs, soft delete, required helpers, React hooks pitfalls).

## 🗂️ Entities

**Recipes** have multiple sections, each of which has **Ingredients** and an amount. Ingredients can also be other recipes.

**Products** have multiple unit mappings (each of which contain 2 amounts). Products can also point to an ingredient.

**USDA Food** database is loaded, loosely linked to products based on the products NDB number or UPC code.

Products can be inventoried — an **Inventory Entry** specifies the amount of a given **Product** at a given **Location**.

The household **Project Tracker** (migrated from Notion) is its own self-contained module: a **Project** groups **Tasks** and **Expenses** (the spend ledger), with blocked-by/blocking dependency edges between projects and between tasks. A soft-deletable **ProjectToolUsage** edge records that a reusable tool or software Product was used on one exact project. Tool lifetime cost and cost-per-project-use, plus software's non-additive shared spend during a project's effective date window, remain derived from Expenses and live usage edges rather than denormalized. Spend/progress rollups are SQL aggregates — never denormalized. Project `locations` is deliberately free-form `text[]` (house names live in data, not committed enums).

Spend itself is three entities, `Vendor ──< Purchase ──< Expense`: a **Vendor** is the roster of places money goes (identity only), a **Purchase** is one vendor order, receipt, or deliberately separate purchase event — its `orderId`, vendor date, literal `statedTotal`, and invoice documents — and an **Expense** is a spend line within that Purchase. `Expense.lineKind` distinguishes `principal` merchandise/services from productless tax, shipping, discounts, fees, tips, and combined adjustments. **All money still lives on `Expense`**: every total reads `SUM(cost)` across every kind, while cost-type/trade/tool analytics classify principal lines only and report adjustments as a signed reconciliation amount. `purchase.statedTotal` is never summed into spend. A partial-unique `(vendorId, orderId)` index makes one order exactly one Purchase. ⚠️ `Purchase` **changed meaning** in this split — the old flat ledger row is now `Expense`; see [docs/terminology.md](docs/terminology.md#vendor-vs-purchase-vs-expense).

Financial settlement is a separate evidence layer: `FinancialAccount ──< FinancialTransaction`, with an optional Transaction → Purchase link, records statement activity (including pending charges, split tender, installments, and refunds). It never changes spend: `Expense.cost` remains the sole spend source. A Purchase is a vendor order/receipt, not a card charge; its `statedTotal` is always the literal vendor-printed total. Financial reconciliation compares linked non-void transactions against live Expense lines as `unknown`, `pending`, `match`, or `mismatch`.

### Public identifiers — shortcodes

Every entity has two ids. The uuid primary key is **private**: repos, services, and
internal tRPC use it and nothing else does. The **shortcode** (`PRD-4K7M`) is the
public id — what appears in URLs, on printed QR labels, and as the `id` field over
MCP. Codes are non-null, immutable, never reused (uniqueness spans soft-deleted
rows, so a retired code is a permanent tombstone), and case-insensitive on input.

| Entity | Prefix | | Entity | Prefix | | Entity | Prefix |
|---|---|---|---|---|---|---|---|
| cookbook | `CKB-` | | inventory | `INV-` | | purchase | `PUR-` |
| expense | `EXP-` | | location | `LOC-` | | recipe | `RCP-` |
| ingredient | `ING-` | | meal | `MEL-` | | task | `TSK-` |
| product | `PRD-` | | project | `PRJ-` | | vendor | `VEN-` |
| financial account | `FAC-` | | financial transaction | `FTX-` | | — | — |
| wishlist | `WSH-` | | — | — | | — | — |

`Image` is the one entity with no shortcode — it has no MCP surface and is only
ever reached through the entity that owns it.

The body is four characters from a 31-character alphabet (digits and uppercase
letters minus the scan-confusable `0 O 1 I L`) — 923,521 codes per prefix.
`P-`/`R-`/`L-` were the pre-2026-07 prefixes for product/recipe/location; they
still resolve on input, forever, so labels printed before the cutover keep
working. Because the swap preserved each code's body (`P-4K7M` → `PRD-4K7M`),
that needs only a three-entry alias map, not an alias table. The registry lives
in `packages/shared/src/shortcode.ts`; resolution goes through
`apps/web/src/server/repo/shortcode-resolver.ts` and nowhere else.

```mermaid
erDiagram
    Recipe ||--o{ RecipeSection : "has sections"
    RecipeSection ||--o{ RecipeSectionIngredient : "has ingredients"
    Ingredient ||--o{ RecipeSectionIngredient : "used in"
    Recipe ||--o| Ingredient : "can be ingredient"

    Product ||--o{ InventoryEntry : "inventoried as"
    Product }o--|| Ingredient : "points to"

    Location ||--o{ InventoryEntry : "contains"

    Image ||--o{ Product : "linked to"
    Image ||--o{ Location : "linked to"
    Image ||--o{ Recipe : "linked to"

    Product }o--o| usda_food : "linked by UPC/NDB"

    Project ||--o{ Task : "has"
    Project ||--o{ Expense : "has"
    Project }o--o{ Project : "blocked by"
    Task }o--o{ Task : "blocked by"
    Image ||--o{ Project : "linked to"

    Vendor ||--o{ Purchase : "issued"
    Purchase ||--o{ Expense : "has expenses"
    FinancialAccount ||--o{ FinancialTransaction : "records activity"
    Purchase o|--o{ FinancialTransaction : "is settled by"
    Image ||--o{ Purchase : "documents"
    Product ||--o{ Expense : "bought as"
```

## 🛠️ Development Setup

Prereqs: **Node** (see [.nvmrc](.nvmrc), currently `v24`), **pnpm** (pinned in [package.json](package.json) — `packageManager: pnpm@10.34.1`), **Docker**, **wrangler** (for CF Workers work).

```sh
# 1. Install
pnpm install

# 2. Env
cp apps/web/.env.example apps/web/.env
# Edit apps/web/.env — see "Environment Variables" below

# 3. Local services (Postgres 17 + IntegresQL + Jaeger)
docker-compose up -d

# 4. Web DB schema
pnpm --filter @cubby/web run db:push

# 5. Build the WASM shim (one-time, or whenever recipebridge/ changes)
pnpm run wasm

# 6. Dev server
pnpm run dev
```

App: <http://localhost:3000> · Jaeger: <http://localhost:16686>

### Environment Variables

Required keys (see [apps/web/.env.example](apps/web/.env.example) for the full file):

| Key | Purpose |
|---|---|
| `BETTER_AUTH_SECRET` | Auth signing secret |
| `DATABASE_URL` | PostgreSQL connection (defaults to local docker-compose) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` / `R2_BUCKET_NAME` / `R2_PUBLIC_URL` | Image storage |
| `USDA_API_URL` | USDA service URL (defaults to `http://localhost:8787/` for local Wrangler dev) |
| `UPC_LOOKUP_API_URL` / `UPC_LOOKUP_API_KEY` | UPC lookup worker |
| `NOTION_API_KEY` | *(optional)* Notion recipes import |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(optional)* OTLP traces → Jaeger |

### Worktrees (parallel sessions)

Claude Code and Codex can run parallel sessions in isolated git worktrees.
Claude keeps managed worktrees under `.claude/worktrees/<name>`; Codex keeps
them under `$CODEX_HOME/worktrees`. A few things to know:

- **Fresh worktree setup:** Codex and Claude both run
  [scripts/setup-agent-environment.mjs](scripts/setup-agent-environment.mjs)
  automatically. Codex calls it from
  [.codex/environments/environment.toml](.codex/environments/environment.toml);
  Claude calls it for new linked-worktree sessions from
  [.claude/settings.json](.claude/settings.json). It installs only when the
  workspace lockfile is not current, then builds WASM only when missing or stale.
  Gitignored env (`apps/web/.env`, `.env.local`) is copied automatically via
  [.worktreeinclude](.worktreeinclude); `node_modules` and the gitignored WASM
  package (`packages/wasm/*`) are not copied.
- **Builds are shared, not cold.** The `wasm` script points `CARGO_TARGET_DIR` at a
  shared cache (`~/.cache/cubby/recipebridge-target`), so worktrees reuse the
  compiled Rust deps — a worktree `pnpm run wasm` is an incremental build, not the
  ~90s cold one, and there's no 1.3GB `target/` per worktree.
- **WASM never silently drifts.** [scripts/ensure-wasm.mjs](scripts/ensure-wasm.mjs)
  rebuilds the gitignored WASM only when a source it's built from is newer than the
  built binary. "Sources" is `recipebridge/` **plus every local path-dependency**
  `cargo metadata` reports (`source: null`) — notably the
  [ingredient-parser](https://github.com/nickysemenza/ingredient-parser) working
  copy the global `~/.cargo` `[patch]` redirects to, so editing the parser locally is
  caught too (no patch → only `recipebridge/`, same as CI). It runs on `pnpm dev`
  (so a local parser edit rebuilds on the next dev start) and on `git pull`/`git
  checkout` (husky `post-merge`/`post-checkout`, for a pulled rev bump or branch
  switch) — on the **main** checkout too. cargo does the real incremental compile;
  this is just the staleness gate that skips the ~10s wasm-bindgen/opt when fresh.
- **Ports.** The main checkout is always `:3000` (`vite.config.ts` uses `strictPort`,
  so it fails loudly rather than drifting). Worktree dev servers auto-pick a free
  port — the preview harness via `autoPort` (injects `PORT`), or a terminal
  `pnpm dev` via vite's auto-increment.
- **Previewing a worktree:** in Claude, start with the **worktree folder itself**
  selected as the project (`<repo>/.claude/worktrees/<name>`) so preview resolves
  that checkout's `launch.json`. In Codex, start the task in Worktree mode and use
  the `Web` or `Dev stack` action from the local environment. Any linked worktree
  without an injected `PORT` auto-picks a free port; the main checkout remains
  strict on `:3000`.
- **Shared services:** docker-compose (Postgres/IntegresQL/Jaeger) binds fixed host
  ports — `docker-compose up -d` once from any checkout and all worktrees reuse them
  for `test`/`test:e2e`.
- **⚠ Shared prod DB:** every worktree's `DATABASE_URL` is the **same prod Neon**
  instance (dev DB *is* prod). `db:push` and data changes from one worktree are
  visible everywhere and hit prod — coordinate schema changes across parallel work.
- Editing `recipebridge/` Rust source — or the patched sibling ingredient-parser
  checkout — is picked up automatically on the next `pnpm dev` (see "WASM never
  silently drifts" above); `pnpm run wasm` forces it. Needs the rust toolchain + the
  global cargo patch + the sibling ingredient-parser checkout.

## ⚡ Common Commands

| Command | What it does |
|---|---|
| `pnpm run dev` | Start the web, UPC, and USDA local services |
| `pnpm run build` | Build all three production Worker bundles |
| `pnpm run check` | Biome (zero warnings), TypeScript, Worker/OpenAPI drift, Knip, dedupe, audit policy, and conventions |
| `pnpm run typecheck` | Recursive package typecheck with `tsc` (TypeScript 7, native) |
| `pnpm run lint` | Recursive package Biome lint |
| `pnpm run format:check` | Recursive package Biome format/lint check |
| `pnpm run format:write` | Recursive package Biome auto-fix |
| `pnpm run test` | Recursive non-watch Vitest unit + integration |
| `pnpm run test:e2e` | Playwright E2E (uses IntegresQL) |
| `pnpm --filter @cubby/web run db:push` | Push the web Drizzle schema to the configured Postgres DB |
| `pnpm --filter @cubby/web run build:cf` | Build only the main web Worker |
| `pnpm --filter @cubby/web run preview:cf` | Run the Workers build locally |
| `pnpm --filter @cubby/web run deploy:cf` | Deploy to Cloudflare Workers |
| `pnpm run wasm` | Rebuild `@cubby/recipebridge` from Rust source |

The auxiliary Workers (`@cubby/upc-lookup` and `@cubby/usda-api`) are included in
recursive checks/tests. Their D1 databases do not use the web `db:push` workflow:
generate/apply their D1 migrations locally first, run the package checks, then apply
remote D1 migrations before deploying code that depends on the new schema. Use staged
expand/migrate/deploy/cleanup changes for incompatible D1 schema changes.

Temporary upstream pins, peer-range exceptions, and transitive deprecation
rationales are tracked in [docs/dependency-exceptions.md](docs/dependency-exceptions.md).

In dev, `await __jsProfile(5000)` in the browser console captures a CPU flame summary (the hottest main-thread frames over the next N ms) — it catches "every measurement is fast but the page is slow" jank that React's profiler can't see (commit-phase / native / third-party work).

## 🧪 Testing

| Suffix | Purpose | Runner |
|---|---|---|
| `*.unit.test.ts` | Unit tests | Vitest |
| `*.integration.test.ts` | Integration tests (real DB via IntegresQL) | Vitest |
| `*.spec.ts` | E2E tests | Playwright |

E2E tests use IntegresQL to spin up fresh databases per test — see memory notes for SSR hydration gotchas and the `e2e-helpers.ts` shared helpers.

### File Naming Conventions

| Pattern | Example | Used For |
|---|---|---|
| `*.service.ts` | `product.service.ts` | Service layer (enrichment) |
| `*-helpers.ts` | `database-helpers.ts` | Utility helpers |
| `*-utils.ts` | `location-utils.ts` | Utility functions |
| `types.ts` / `internal-types.ts` | `repo/product/types.ts` | Local type definitions |

## 🚀 Deployment — `apps/web` on Cloudflare Workers

What deploys where lives in the [Monorepo Layout](#-monorepo-layout) table. This section covers the non-trivial internals of the main app's CF Workers deploy. (`upc-lookup` and `usda-api` are also Cloudflare Workers.)

The dev server is plain Node via `vite dev`. Production = CF Workers.

| File | Purpose |
|---|---|
| [apps/web/src/cf-server.ts](apps/web/src/cf-server.ts) | Worker entry — wraps each request with `withRequestDb()` |
| [apps/web/src/server/db.ts](apps/web/src/server/db.ts) | Per-request `pg.Pool` via `AsyncLocalStorage` (CF) or module-level pool (dev) |
| [apps/web/src/lib/recipebridge-cf.ts](apps/web/src/lib/recipebridge-cf.ts) | WASM wrapper using `?init` pattern for CF |
| [apps/web/wrangler.jsonc](apps/web/wrangler.jsonc) | Worker config (name, vars, Hyperdrive, compat flags) |
| [apps/web/vite.config.ts](apps/web/vite.config.ts) | `cfWasmPlugin()` + `__CF_WORKERS__` define for dead-code elimination |

Key constraints:

- **Hyperdrive** pools TCP connections at CF's edge. The connection string comes from `env.HYPERDRIVE.connectionString` (not a secret).
- **Per-request `pg.Pool`** (`max: 5`) via `withRequestDb()` + `AsyncLocalStorage`. A single `pg.Client` would serialize a request's query fan-out on one connection; a small pool lets independent queries run in parallel. `max: 5` is the Workers per-invocation connection ceiling (~6 simultaneous outbound TCP), distinct from Hyperdrive's 60-connection origin pool shared across all invocations.
- **Hyperdrive query caching is ON** — read queries are cached at the CF edge (~4ms PoP hit vs a us-west-2 round trip), which also relieves Neon's egress cap. This is **account-level config on the Hyperdrive object, not expressible in `wrangler.jsonc`** (the binding only holds `binding` + `id`). It's set via the dashboard or, reproducibly:
  ```sh
  wrangler hyperdrive update adc9757dfffd45bc94d5c2a66b2ad410 --max-age 60 --swr 15
  ```
  Caveats: only SELECTs **outside** an explicit transaction are cached (so keep hot list reads out of `withTransaction`), and queries containing STABLE functions (`NOW()`/`CURRENT_DATE`) are uncacheable — repo reads pass `new Date()` as a bound param, so they stay cacheable.
- **WASM uses `?init`** because `vite-plugin-wasm` doesn't apply to CF's SSR environment. `cfWasmPlugin()` redirects `@cubby/recipebridge` to `recipebridge-cf.ts`.
- **`__CF_WORKERS__` define** eliminates module-level Pool creation from the CF build.
- **OTel disabled in production** — only runs in dev via `instrument.server.mjs`.
- Secrets via `wrangler secret put BETTER_AUTH_SECRET` (etc.) — see `wrangler.jsonc` for the full list.

## 🔐 Authentication

Better-Auth via `better-auth/tanstack-start`. Routed UI by `@daveyplate/better-auth-ui`.

| File | Purpose |
|---|---|
| [apps/web/src/lib/auth.ts](apps/web/src/lib/auth.ts) | Server config |
| [apps/web/src/lib/auth-client.ts](apps/web/src/lib/auth-client.ts) | Client (`useSession` and friends) |
| [apps/web/src/routes/api/auth/$.ts](apps/web/src/routes/api/auth/$.ts) | API catch-all route |
| [apps/web/src/routes/auth.$authView.tsx](apps/web/src/routes/auth.$authView.tsx) | Auth UI (sign-in/up) |
| [apps/web/src/routes/_authenticated/account.$accountView.tsx](apps/web/src/routes/_authenticated/account.$accountView.tsx) | Account UI |
| [apps/web/src/routes/oauth.consent.tsx](apps/web/src/routes/oauth.consent.tsx) | OAuth consent screen |
| [OAuth/OIDC discovery routes](apps/web/src/routes/%5B.%5Dwell-known.oauth-authorization-server.ts) | OAuth/OIDC discovery documents |

Visit <http://localhost:3000/api/auth/session> while running the app to inspect the current session, and <http://localhost:3000/api/auth/reference> (dev only) for the Scalar reference of every auth endpoint.

### Connecting to the MCP server

`/api/mcp` is an **OAuth 2.1 resource server** — cubby is its own authorization
server (better-auth's `oauthProvider` + `jwt` plugins), and clients enrol
themselves through dynamic client registration. There is no API key and no
`?key=` query param; access tokens are short-lived JWTs verified locally against
`/api/auth/jwks`.

- **claude.ai** — add a custom connector pointing at
  `https://cubby.nickysemenza.com/api/mcp`. No query string, no headers. It
  registers itself, sends you through sign-in and the `/oauth/consent` screen,
  and stores the resulting token.
- **Claude Code** — the `cubby-localhost` entry in `.mcp.json` is just `{"type": "http",
  "url": "..."}`. Authorize once with `claude mcp login cubby-localhost` (or `/mcp` →
  authenticate); the refresh token keeps non-interactive runs (`claude -p`, the
  Agent SDK) working afterwards. **Do not add an `Authorization` header** — a
  static header suppresses the OAuth flow, and the connection just fails.
- **Codex** — `.codex/config.toml` registers `cubby-localhost` as an OAuth HTTP
  MCP server. With the web app running, authorize once with
  `codex mcp login cubby-localhost`; the desktop app, CLI, and IDE extension
  share the stored login.

Preview deploys are not supported: each gets a unique
`<prefix>-cubby.nicky.workers.dev` host, and the accepted token audience is
pinned to one origin per environment in [auth.ts](apps/web/src/lib/auth.ts).

### MCP Apps (interactive UIs in the conversation)

Two tools render an interactive UI in hosts that support the
[MCP Apps extension](https://modelcontextprotocol.io/docs/extensions/apps)
(SEP-1865) — Claude web and desktop among them:

| Tool | App |
|---|---|
| `get_shopping_list` | Checkable list grouped by availability, per-meal breakdown behind each item |
| `search_usda_foods` | Pickable cards with data-type richness cues and macros; selection flows back to the agent |

The UI is **strictly additive** — a host without the extension ignores
`_meta.ui.resourceUri` and gets the same `structuredContent` as before. Scope is
deliberately narrow: an app earns its place only where the chat is the right
home for the interaction *and* text is a bad medium for it. Tables, boards, and
charts stay in the web app, one `openLink` away.

Sources live in [apps/mcp-apps/](apps/mcp-apps/) — its own workspace package,
because it's a separate build target with a different runtime (sandboxed iframe,
no React, no tRPC, no Tailwind). It doesn't deploy on its own: it builds to
self-contained HTML that [server/mcp/apps/](apps/web/src/server/mcp/apps/)
inlines and serves as `ui://` resources, driven off the manifest in
[src/bundles.ts](apps/mcp-apps/src/bundles.ts) — the one place an app is
declared. `scripts/ensure-mcp-apps.mjs` gates apps/web's `dev`, `test`, and
`build:cf`, rebuilding only when a source is newer than the bundles.

`pnpm --filter @cubby/mcp-apps dev` runs a local host harness that drives the
real AppBridge protocol against fixture data — no tunnel or connector needed,
which matters because MCP is unreachable on preview deploys.

Brand primitives come from [@cubby/design-tokens](packages/design-tokens/) — the
same file `apps/web` imports — so the palette and type stacks can't drift
between the web app and the iframes.

## 🥫 Product Types

| Type | Example | Characteristics |
|---|---|---|
| **Specific Item** | "Kraft Macaroni & Cheese" | Has UPC, manufacturer, price, nutrition. Created via barcode scan. |
| **Misc Collection** | `misc:random cables` | Opaque placeholder. Just a name, no details. Prefix with `misc:`. |

## ⚖️ Unit Conversion (WASM)

- `@cubby/recipebridge` wraps Rust WASM from [ingredient-parser](https://github.com/nickysemenza/ingredient-parser).
- Client-side: `wasm` from `~/lib/wasm` (sync).
- Server-side: `wasmServer` (async, auto-initializing).
- Supports **chained conversions** via graph algorithms — e.g. `2 cups → $5.00 → 333g` using a product's unit mappings.

## 🥕 USDA Integration

- **Contract:** `@cubby/usda-contract` defines endpoints with Zod schemas (ts-rest).
- **Schemas:** `@cubby/usda-schemas` for shared entity types.
- **Client:** [apps/web/src/server/clients/usda.ts](apps/web/src/server/clients/usda.ts) wraps the ts-rest client.
- **Router:** [apps/web/src/server/api/routers/usda.ts](apps/web/src/server/api/routers/usda.ts).
- Service layer processes USDA portion data through WASM for conversions.

```ts
usdaClient.findFood({ kind: "upc", gtin_upc: "123456789012" });
usdaClient.findFood({ kind: "ndb", ndb_number: 12345 });
usdaClient.listFoods(nameFilter, dataTypeFilter, sort, pagination);
usdaClient.getFoodSummaryByID(fdcId);
```

## 🗺️ Roadmap

Framed as **Now / Next / Later** (no dates — it's a personal project). The canonical backlog, with per-item design decisions inline, is [docs/todos.md](docs/todos.md); the links are pointers, not summaries, so they don't rot.

### Recently shipped

- **Tool wishlist** — a `Wish` entity (`WSH-`) for tracking wanted-but-not-yet-owned items, independent of inventory or projects.
- **Manufacturer spelling snapped on create** — `create_product`/`create_products` now resolve `manufacturer` to the established spelling already used among live Products, closing the drift that let variant spellings accumulate; `update_product` deliberately does not auto-snap.
- **Financial accounts & transactions** — a settlement evidence layer, `FinancialAccount ──< FinancialTransaction`, separate from spend: statement activity (pending charges, split tender, installments, refunds) with an optional link to the Purchase it settles. `Expense.cost` remains the sole spend source; reconciliation compares linked transactions against Expense lines as `unknown`/`pending`/`match`/`mismatch`. Client-parsed Monarch statement preview drives selective, user-approved creation.
- **Typed Expense line roles** — `Expense.lineKind` (`principal`, tax, shipping, discount, fee, tip, other adjustment) distinguishes merchandise/services from productless receipt adjustments, all still summed into `SUM(Expense.cost)`, while excluding adjustment rows from merchandise/category analytics.
- **`ProjectToolUsage`** — a durable, deliberately coarse edge recording that a reusable tool or software Product was used on a project, feeding tool-lifetime-cost and cost-per-project-use rollups without double-counting the original Expense.
- **Vendor / Purchase / Expense split** — the flat spend ledger became `Vendor ──< Purchase ──< Expense`. The old ledger row is now **`Expense`** (routes `/expenses`, MCP `*_expense(s)` tools); **`Purchase`** is a vendor order/receipt event holding its order id, vendor date, literal never-summed `statedTotal`, and invoice PDF; **`Vendor`** is a real roster. Create/update inputs still take `vendor` (a name) and `orderId` and resolve both on first sight. New operations: `linkExpensesToPurchase`, `splitExpense`, `mergePurchases`.
- **Project tracker migration + maturation** — the household projects/tasks/expenses databases moved from Notion into first-class cubby entities (DB tables, full CRUD UI at `/projects` `/tasks` `/expenses`, MCP tools, dashboard + charts). Follow-ups consolidated the entities onto shared helpers and the entity manifest, added detail pages with full editing UI, wired all three into global search + semantic embeddings, and made them first-class in inline links/hovercards (with mobile dialogs). The one-time import script was removed post-cutover (recoverable from git history).
- **Unified planning calendar** — meals, task ranges, planned/actual expenses, and project spans share a filterable month view with a day drawer, quick-add flows, and selective drag-to-reschedule. The Meals calendar tab reuses the same implementation.

### Current and future work

The authoritative Now / Next / Later ordering lives only in the
[backlog triage board](docs/todos.md#triage-board), alongside each item's design
constraints and promotion triggers. The README deliberately does not mirror the
queue.

## 📚 Further Docs

- [CLAUDE.md](CLAUDE.md) — agent rules, anti-patterns, required helpers
- [docs/style-guide.md](docs/style-guide.md) — Tailwind/CSS conventions
- [docs/todos.md](docs/todos.md) — the canonical backlog: goals + load-bearing design decisions + rejected alternatives
- [docs/terminology.md](docs/terminology.md) — glossary disambiguating UI / code / DB names per concept
- [docs/inventory-audit.md](docs/inventory-audit.md) — inventory audit/session flow: purpose, current behavior, known gaps, redesign direction
