# 🥡 cubby

Recipe database and home inventory database, tied together. A personal pantry-and-cooking system: track what you own, where it lives, what it cost, and what you can cook with it.

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/nickysemenza/cubby)

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
3. **Rare and interactive work stays interactive.** Cookbook/EPUB import runs a few times a year with a human watching; it needs no queue, retries, or DLQ. The background queue is for work that is frequent, unattended, or slow enough to break a request (embeddings, recipe-total cascades, location AI) — not for making rare work look industrial. Derived data that is cheap to compute is computed at the source (in the write transaction or on read), never deferred.
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
- Merge duplicate Products into one survivor — stock, ledger lines, external identifiers, images, unit mappings, tasks, project uses, and wishlist candidacies move onto the keeper, with same-location stock summed rather than dropped

**Recipes**
- Multi-section recipes with nested ingredients
- Ingredients can be other recipes (composition)
- Side-by-side recipe comparison
- Cost rollups via product unit mappings
- Prep-sheet, nested (spec), ingredient × component matrix, and AI-assembled step-flow views, plus a print/export route
- Recipe flows open as guided walkthroughs: ordered stops pair scaled ingredients with original instructions and expandable AI explanations; map and table layouts remain available
- Client-side scaling (multiplier / target weight / anchor ingredient)

**Cookbooks**
- Import a cookbook from an EPUB — chapters chunked and assembled into recipes (client-side WASM extraction, server-side LLM proxy)
- Recipes keep a `recipeSource` pointer back to the cookbook they came from

**Meals**
- Plan recipes on shared month and focused week calendars (plus a table view), scaled per meal
- Classify each meal by slot (breakfast → dessert, ordering the calendar day) and by kind — a `eating out` / `takeout` meal is a recipe-less placeholder on purpose, and only `cooked` meals feed the shopping list. Calendar chips carry the slot as their glyph; non-cooked meals read as dashed
- Shopping list — aggregated need vs. on-hand inventory, with a per-meal breakdown, estimated trip cost, and shop-friendly units (display-only; see [Tenets](#tenets))
- Suggestions — *"what can I make tonight?"* from recorded stock plus explicitly marked **Usually on hand** ingredients. These ingredient-level staples mean “assume I have enough”; aliases share the setting, brands do not own it, and inventory is never fabricated or decremented.
- Shopping shows staples and their required quantities in a separate **Usually on hand** section, including in copy/print, and excludes them from the buy list and estimated total. Missing quantities and blocked sub-recipes remain visible.

**Planning calendar**
- Month overview and Sunday–Saturday focus views for meals, due tasks, expenses, and multi-day project spans — a ruled day-by-day agenda on phones, where a seven-column grid can't be read
- Source and project-kind filters, date drawers with daily totals, and quick-add flows
- Drag-to-reschedule for meals, tasks, and planned expenses; actual expenses and project spans stay read-only
- Published iCalendar feeds (`webcal://…/api/calendar/<token>/{all,meals,tasks}.ics`) for meals and open task due dates, subscribable from macOS/iOS Calendar; read-only, and the URL's token is the only credential

**USDA**
- Full USDA FoodData Central database loaded into a sibling service
- Browse, search, and link products by barcode or FDC id

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
- Dashboard with overview/charts/data/gallery views (spending, timelines, task heatmaps, dependency graph); Data view offers a flat list or an expandable Work-Breakdown-Structure tree, both paginated by project root on the server
- Detail pages with full inline editing, markdown notes, and image galleries
- First-class inline links/hovercards, global + semantic search, full MCP CRUD

**Financial accounts & transactions**
- `FinancialAccount ──< FinancialTransaction ──< FinancialTransactionAllocation >── Purchase` — a settlement evidence layer separate from spend: statement activity (pending charges, split tender, installments, refunds). A transaction is allocated across the Purchases it settled, so one real card line can settle several orders; allocations sum to the transaction amount and never enter spend
- Never changes spend — `Expense.cost` remains the sole spend source; reconciliation compares linked non-void transactions against live Expense lines as `unknown` / `pending` / `match` / `mismatch`
- Client-parsed Monarch statement preview → selective creation, never a CSV upload path

**Wishlist**
- A simple wanted-items list (name, notes, optional price, acquired toggle) for tracking things not yet owned, independent of inventory or projects
- Optional candidate Tool products per wish, each with its own cover image and price; the list shows a merged cover thumbnail and a sortable price range, and expands a wish into its candidates' own rows

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
- **API:** Entity Kernel + TanStack Start entity transport + explicit workflow/MCP adapters
- **Data:** Drizzle ORM · PostgreSQL · Hyperdrive (edge pool)
- **Auth:** Better-Auth (`@daveyplate/better-auth-ui` for routed UI)
- **Edge:** Cloudflare Workers + Wrangler
- **WASM:** `@cubby/recipebridge` wraps Rust [ingredient-parser](https://github.com/nickysemenza/ingredient-parser)
- **Storage:** Cloudflare R2 (S3-compatible) for images
- **Charts:** Nivo (bar, pie, treemap, sunburst, calendar, line) + d3-force, d3-hierarchy
- **Tooling:** Oxlint + Oxfmt (lint + format) · Vitest (unit/integration) · Playwright (E2E) · PostgreSQL + IntegreSQL (authoritative contracts)
- **Observability:** OpenTelemetry → Jaeger (dev only) · Sentry (the Apple app reports to its own `cubby-apple` project)

The reconstructable provider inventory, resource identifiers, secret names,
and drift-check procedure live in [docs/infrastructure.md](docs/infrastructure.md).

## 📦 Monorepo Layout

### Apps (deployed)

| Path | Package | Role | Runtime | Deploys to |
|---|---|---|---|---|
| [apps/web](apps/web) | `@cubby/web` | Main app — TanStack Start + Entity Kernel + Drizzle | Cloudflare Workers | Worker `cubby` · DB via **Hyperdrive** → Postgres |
| [apps/upc-lookup](apps/upc-lookup) | `@cubby/upc-lookup` | UPC barcode lookup API — Hono + D1 | Cloudflare Workers | Worker `upc-lookup` · <https://upc-lookup.nicky.workers.dev> |
| [apps/usda-api](apps/usda-api) | `@cubby/usda-api` | USDA FoodData Central API — Hono + D1/R2 bundles | Cloudflare Workers | Worker `usda-api` · <https://usda-api.nicky.workers.dev> · D1 search index + R2 NDJSON payload bundles |
| [apps/apple](apps/apple) | (no package.json) | Native proof-of-concept iOS + macOS app, `CubbyKit` Swift package, `cubby` CLI harness | iOS 26 / macOS 26 (SwiftUI, Swift 6 strict concurrency) | Local install (Xcode / simulator / device); no hosted deploy |

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
| [cubby-ffi/](cubby-ffi) | (Rust source) | UniFFI boundary exposing `recipebridge`'s ingredient parser to Swift (same Rust source as the WASM build) | Built into `apps/apple`'s `CubbyFFI.xcframework` via `apps/apple/scripts/build-rust.sh` |

## 🏗️ Architecture

Generic entity flow:

```
TanStack Start  →  Entity Kernel  →  Repo  →  Database
Start workflows ───────────────↗
MCP / jobs      ───────────────↗
JSONL routes    →  cancellable workflow streams
```

- Typed declarations with real Zod schemas in `packages/schemas/src/entity-definitions/*.entity.ts` compile the exhaustive manifest, schema bindings, browser roster, filter URL catalog, kernel action capabilities, and contract cases. `pnpm generate:check` rejects stale or invalid artifacts; typecheck verifies referenced exports.
- `executeEntity` is the baseline CRUD/filter/search/relation interface. TanStack Start is the browser entity adapter; MCP and jobs invoke the kernel directly. Explicit Start functions adapt workflows, while typed JSONL routes carry cancellable progress streams.
- Services own workflows and external enrichment such as USDA data. Repositories retain transaction ownership, invariants, and entity-specific SQL.
- `Database` is a request-scoped handle: routers and services pass it through, while repository helpers are the sanctioned place to resolve its Drizzle client. This keeps the layered architecture by convention and API locality.
- Adding a baseline entity starts with one compiler spec, followed by the repository adapter and any thin workflow or route extensions; see [docs/entities.md](docs/entities.md).

See [AGENTS.md](AGENTS.md) for the prescriptive rules (branded IDs, soft delete, required helpers, React hooks pitfalls).

## 🗂️ Entities

**Recipes** have multiple sections, each of which has **Ingredients** and an amount. Ingredients can also be other recipes.

**Products** have multiple unit mappings (each of which contain 2 amounts). Products can also point to an ingredient.

**USDA Food** database is loaded, loosely linked to products by an explicit `fdc_id` or, failing that, by any of the product's barcodes.

Products can be inventoried — an **Inventory Entry** specifies the amount of a given **Product** at a given **Location**.

The household **Project Tracker** (migrated from Notion) is its own self-contained module: a **Project** groups **Tasks** and **Expenses** (the spend ledger), with blocked-by/blocking dependency edges between projects and between tasks. A soft-deletable **ProjectToolUsage** edge records that a reusable tool or software Product was used on one exact project. Tool lifetime cost and cost-per-project-use, plus software's non-additive shared spend during a project's effective date window, remain derived from Expenses and live usage edges rather than denormalized. Spend/progress rollups are SQL aggregates — never denormalized. Project `locations` is deliberately free-form `text[]` (house names live in data, not committed enums).

Spend itself is three entities, `Vendor ──< Purchase ──< Expense`: a **Vendor** is the roster of places money goes (identity only), a **Purchase** is one vendor order, receipt, or deliberately separate purchase event — its `orderId`, vendor date, literal `statedTotal`, and invoice documents — and an **Expense** is a spend line within that Purchase. `Expense.lineKind` distinguishes `principal` merchandise/services from productless tax, shipping, discounts, fees, tips, and combined adjustments. **All money still lives on `Expense`**: every total reads `SUM(cost)` across every kind, while cost-type/trade/tool analytics classify principal lines only and report adjustments as a signed reconciliation amount. `purchase.statedTotal` is never summed into spend. A partial-unique `(vendorId, orderId)` index makes one order exactly one Purchase. ⚠️ `Purchase` **changed meaning** in this split — the old flat ledger row is now `Expense`; see [docs/terminology.md](docs/terminology.md#vendor-vs-purchase-vs-expense).

Financial settlement is a separate evidence layer: `FinancialAccount ──< FinancialTransaction`, allocated across the Purchases it settles, records statement activity (including pending charges, split tender, installments, and refunds). It never changes spend: `Expense.cost` remains the sole spend source. A Purchase is a vendor order/receipt, not a card charge; its `statedTotal` is always the literal vendor-printed total. Financial reconciliation compares linked non-void transactions against live Expense lines as `unknown`, `pending`, `match`, or `mismatch`.

### Public identifiers — shortcodes

Every entity has two ids. The uuid primary key is **private**: repos, services, and
internal workflow code uses it and nothing else does. The **shortcode** (`PRD-4K7M`) is the
public id — what appears in URLs, on printed QR labels, and as the `id` field over
MCP. Codes are non-null, immutable, never reused (uniqueness spans soft-deleted
rows, so a retired code is a permanent tombstone), and case-insensitive on input.

| Entity | Prefix | | Entity | Prefix | | Entity | Prefix |
|---|---|---|---|---|---|---|---|
| cookbook | `CKB-` | | inventory | `INV-` | | purchase | `PUR-` |
| expense | `EXP-` | | location | `LOC-` | | recipe | `RCP-` |
| ingredient | `ING-` | | meal | `MEL-` | | task | `TSK-` |
| product | `PRD-` | | project | `PRJ-` | | vendor | `VEN-` |
| financial account | `FAC-` | | financial transaction | `FTX-` | | image | `IMG-` |
| wishlist | `WSH-` | | — | — | | — | — |

`Image` carries a code like every other local-table entity. It was the last
holdout, addressed by raw uuid — which made it a permanent carve-out in every
shape that could name an entity, so it was given a prefix rather than kept as an
exception. The remaining uuid exceptions are all *sub-entity* ids (the
`mealRecipe` id inside a meal's `recipes[]`, recipe section and section-line ids,
unit-mapping ids); none of them are manifest entities.

The body is four characters from a 31-character alphabet (digits and uppercase
letters minus the scan-confusable `0 O 1 I L`) — 923,521 codes per prefix.
`P-` and `L-` are permanent inbound aliases for Product and Location because
physical labels using them already exist. Cubby emits only `PRD-` and `LOC-`;
the four-character body is preserved during the prefix rewrite, so no alias
table is needed. The former Recipe `R-` alias is intentionally no longer
recognized; old `R-XXXX` links are a breaking compatibility removal and must be
replaced with `RCP-XXXX`. The generated registry lives
in `packages/shared/src/shortcode.ts`; resolution goes through
`apps/web/src/server/repo/shortcode-resolver.ts` and nowhere else.

The complete relationship graph is compiled from the entity literals rather
than duplicated here. The in-app `/entities?tab=integrity` inspector renders
logical cardinality, inverse paths, and named provenance alongside physical FK
edges and operation-specific delete/merge behavior. The documentation diagram
uses the same generated manifest for its bounded core view; see
[the entity compiler contract](docs/entities.md#relations-deletion-and-merge).

## 🛠️ Development Setup

Prereqs: **Node** (see [.nvmrc](.nvmrc), currently `v24`), **pnpm** (pinned in [package.json](package.json) — the `packageManager` field), and **wrangler** (for CF Workers work). On macOS, install Apple `container` and run `container system start` once. PostgreSQL and browser test commands manage disposable services automatically. Fast tests need no container runtime; Linux and CI use external PostgreSQL/IntegreSQL services.

```sh
# 1. Install
pnpm install

# 2. Env
cp apps/web/.env.example apps/web/.env
# Edit apps/web/.env — see "Environment Variables" below

# 3. Build the WASM shim (one-time, or whenever recipebridge/ changes)
pnpm run wasm

# 4. Dev server (uses your configured DATABASE_URL)
pnpm run dev
```

Database-backed tests start and stop their own services on macOS. For example,
`pnpm test:file:postgres src/server/repo/vendor.integration.test.ts`
uses disposable databases, independently of your application's `DATABASE_URL`.
For optional traces, run `pnpm trace` in another terminal and enable
`CUBBY_OTEL=1` for the app. Ctrl-C stops Jaeger.

App: <http://localhost:3000> · Jaeger: <http://localhost:16686>

### Environment Variables

Required keys (see [apps/web/.env.example](apps/web/.env.example) for the full file):

| Key | Purpose |
|---|---|
| `BETTER_AUTH_SECRET` | Auth signing secret |
| `DATABASE_URL` | Application PostgreSQL connection; separate from disposable test databases |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` / `R2_BUCKET_NAME` / `R2_PUBLIC_URL` | Image storage |
| `USDA_API_URL` | USDA service URL (defaults to `http://localhost:8787/` for local Wrangler dev) |
| `UPC_LOOKUP_API_URL` / `UPC_LOOKUP_API_KEY` | UPC lookup worker |
| `NOTION_API_KEY` | *(optional)* Notion recipes import |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(optional)* OTLP traces → Jaeger (`pnpm trace`; defaults to localhost:4318) |

### Worktrees (parallel sessions)

Claude Code and Codex can run parallel sessions in isolated git worktrees.
Claude keeps managed worktrees under `.claude/worktrees/<name>`; Codex keeps
them under `$CODEX_HOME/worktrees`. A few things to know:

- **Fresh worktree setup:** Codex and Claude run `pnpm agent:setup` from
  their existing environment entrypoints. pnpm performs a frozen install, then
  the existing WASM entrypoint restores a matching Nx artifact or builds it. Claude's
  startup hook runs setup only in linked worktrees.
  Gitignored env is copied via [.worktreeinclude](.worktreeinclude);
  dependency links remain local. The type-fixer config dependency and explicit type
  peers preserve TypeScript resolution without changing compiler strictness.
  Measurements are recorded in [local check performance](docs/local-check-performance.md).
- **Builds are shared, not cold.** The `wasm` script points `CARGO_TARGET_DIR` at a
  shared cache (`~/.cache/cubby/recipebridge-target`), so worktrees reuse the
  compiled Rust deps — a worktree `pnpm run wasm` is an incremental build, not the
  ~90s cold one, and there's no 1.3GB `target/` per worktree.
- **WASM never silently drifts.** [scripts/ensure-wasm.ts](scripts/ensure-wasm.ts)
  supplies Cargo's resolved dependency graph, local dependency file contents,
  Cargo configuration and tool versions to the shared Nx cache. This includes
  the [ingredient-parser](https://github.com/nickysemenza/ingredient-parser)
  working copy selected by a global Cargo patch. Changed contents, added/deleted
  files and dependency revisions invalidate the package; checkout timestamps do
  not. Missing Cargo metadata fails setup rather than reusing an unverified build.
  A hit restores the complete `packages/wasm` package and skips Cargo,
  wasm-bindgen and wasm-opt; the key is also stamped into
  `packages/wasm/.fingerprint`, so a checkout whose package already matches
  skips Nx too (~0.3s instead of a multi-second verified hit). The same
  entrypoint runs from dev and the post-merge/post-checkout hooks. `pnpm wasm`
  remains an explicit uncached build. Nx owns artifact storage and the 4 GB
  cache limit.
- **`recipebridge/Cargo.lock` is tracked** so identical worktrees share one
  artifact: `cargo metadata` re-resolves (and rewrites) an untracked lock in
  every fresh checkout, which made every worktree's key unique and its first
  WASM build a full one. The committed form is the one the global Cargo patch
  produces here (parser crates as path entries, no `source =`), exactly like
  `cubby-ffi/Cargo.lock`; CI re-resolves the pinned git revs without `--locked`.
  After a Renovate bump of the parser revs, or when the sibling parser checkout
  changes its own dependencies, the next local run rewrites the lock — commit
  that churn, it is the point.
- **Read-only checks reuse results.** `pnpm lint` and `pnpm format:check` use
  the same Nx targets as `pnpm check`. Documentation and Rust-only edits do not
  invalidate those two targets. `pnpm lint:fix` and `pnpm format` always execute
  their tools because they edit files. Set `NX_SKIP_NX_CACHE=true` for a live run.
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
- **Test services:** on macOS each independent PostgreSQL/browser command owns
  one Apple PostgreSQL/IntegreSQL pair. `pnpm test:all` runs fast tests first, then
  shares one pair across its concurrent database tiers. Container IPs avoid host
  port conflicts, so overlapping worktrees need no coordination. Tests retain
  their separate IntegreSQL databases and template hashes.
- **Lifecycle:** images are cached; containers and test data are removed on
  success, failure, Ctrl-C and SIGTERM. No volumes or per-run networks are created.
  The native container management service may stay running with no workload VMs.
  SIGKILL or a host crash can leave a container: use `container list --all` and
  `container stop <name>` for the unique names printed by the command. Stopped
  leftovers can be removed with `container delete <name>`. No automatic global
  prune runs, so other worktrees are never cleaned up by this wrapper.
- **External services / Docker fallback:** start `docker compose -p cubby up -d`,
  then set `CUBBY_TEST_SERVICES=external` for test commands. Linux and CI already
  use external mode. Endpoints default to localhost:5000 and localhost:5432;
  override `INTEGRESQL_URL`, `INTEGRESQL_DATABASE_HOST`, and
  `INTEGRESQL_DATABASE_PORT` together for another service. Always use `-p cubby`
  with Compose across worktrees. Keep Docker quit with automatic startup disabled
  when using Apple containers; its existing data can remain for rollback.
- **Parallelism:** the Apple pair starts with PostgreSQL at 4 CPUs/2 GiB and
  IntegreSQL at 1 CPU/256 MiB, with a 4/16 database pool and 4 provisioning tasks.
  `VITEST_MAX_WORKERS` overrides the measured PostgreSQL default of 6. Playwright
  gives each worker its own database, object storage, and Worker harness;
  `CUBBY_E2E_WORKERS=1|2|3|4` overrides its local macOS default of 2. CI and Linux
  default to one browser worker. Multiple pairs share the host's finite CPU and memory.
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
| `pnpm run check` | Fast full-tree quality, TypeScript, entity freshness, Knip, and high-risk guards |
| `pnpm run check:all` | `check` plus Worker/OpenAPI, script-test, and security validation |
| `pnpm run dedupe:check` | Dependency deduplication; CI runs it only for manifest/workspace/patch/lockfile changes |
| `pnpm run typecheck` | Recursive package typecheck with `tsc` (TypeScript 7, native) |
| `pnpm run lint` | Full-tree Oxlint |
| `pnpm run lint:fix` | Full-tree Oxlint auto-fix |
| `pnpm run format:check` | Full-tree Oxfmt check |
| `pnpm run format` | Full-tree Oxfmt write |
| `pnpm run test` | All fast unit, UI, contract, and auxiliary-package tests |
| `pnpm run test:postgres` | Authoritative PostgreSQL contracts (disposable Apple containers on macOS) |
| `pnpm run test:e2e` | PostgreSQL-backed Playwright tests (disposable Apple containers on macOS) |
| `pnpm run test:all` | Fast tests, then PostgreSQL and Playwright concurrently |
| `pnpm run test:local` | Alias of `test:all` |
| `pnpm --filter @cubby/web run db:push` | Push the web Drizzle schema to the configured Postgres DB |
| `pnpm --filter @cubby/web run build:cf` | Build only the main web Worker |
| `pnpm --filter @cubby/web run preview:cf` | Run the Workers build locally |
| `pnpm --filter @cubby/web run deploy:cf` | Deploy to Cloudflare Workers |
| `pnpm run deploy:all` | Deploy all four production Workers in dependency order |
| `pnpm run wasm` | Rebuild `@cubby/recipebridge` from Rust source |

See [docs/ci.md](docs/ci.md) for CI scoping, artifact provenance, scheduled
coverage, deployment behavior, and the measured optimizations that should not
be reintroduced.

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
| `*.integration.test.ts` | Authoritative PostgreSQL contracts | Vitest |
| `*.spec.ts` | E2E tests | Playwright |

Local and CI E2E use isolated IntegreSQL PostgreSQL clones. See `e2e-helpers.ts`
for the shared browser fixtures.

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

`pnpm run deploy:all` deploys the complete production system in order: web,
purchase-agent, upc-lookup, then usda-api. It stops at the first failed deploy.
Bare `pnpm deploy` is reserved by pnpm for workspace package deployment; use
`pnpm run deploy:all` for this command.

`pnpm --filter @cubby/web run deploy:cf` builds and deploys the Worker. For
per-chunk gzip reporting, run `CUBBY_BUNDLE_REPORT=1 pnpm --filter @cubby/web run build:cf`;
routine builds skip that reporting but still enforce the service-worker and WASM
size budgets. Footer metadata is loaded on the server and hydrated with the
page, then retained in memory for that document's lifetime. Its source commit
date, branch, and commit are data rather than browser-bundle constants, so
changing them alone does not invalidate client assets or add navigation requests.
SSR keeps Vite's unminified default: deployment trials reduced gzip size with
minification but generally increased Worker startup time. Recheck both metrics
before enabling it.

| File | Purpose |
|---|---|
| [apps/web/src/cf-server.ts](apps/web/src/cf-server.ts) | Worker entry — wraps each request with `withRequestDb()` |
| [apps/web/src/server/db.ts](apps/web/src/server/db.ts) | Per-request `pg.Pool` via `AsyncLocalStorage` (CF) or module-level pool (dev) |
| [apps/web/src/lib/recipebridge-cf.ts](apps/web/src/lib/recipebridge-cf.ts) | WASM wrapper using `?init` pattern for CF |
| [apps/web/wrangler.jsonc](apps/web/wrangler.jsonc) | Worker config (name, vars, Hyperdrive, compat flags) |
| [apps/web/vite.config.ts](apps/web/vite.config.ts) | `cfWasmPlugin()` + `__CF_WORKERS__` define for dead-code elimination |

Key constraints:

- **Hyperdrive** pools TCP connections at CF's edge. Two bindings point at the
  same direct Neon origin: `env.HYPERDRIVE.connectionString` is the
  authoritative/strong-read path, while `env.HYPERDRIVE_CACHED.connectionString`
  serves ordinary cache-eligible reads across all transports.
- **Per-request pools** remain lazy and bounded: up to five connections for
  `HYPERDRIVE` and one for `HYPERDRIVE_CACHED` (six Worker-side connections in
  the largest request). The shared Neon origin budget is 55 Hyperdrive
  connections for the authoritative object plus 5 for the cached object.
- **Shared freshness controls cached reads.** Desired timings live in
  `src/lib/hyperdrive-cache-policy.ts`: 60 seconds cached plus 15 seconds of
  stale-while-revalidate, with 90 seconds of strong reads after household
  writes. `DatabaseFreshnessDurableObject` (`DB_FRESHNESS`, named `household`,
  Western North America placement) stores one monotonic write timestamp per
  database environment. Browser, native, HTTP and MCP operations consult it
  independently; a missing binding or one-second RPC timeout selects strong
  reads. Mutations, credentials, interactive inventory, import preparation and
  explicit diagnostics remain authoritative. Notification failures are logged
  without failing committed writes. Direct SQL and missed notifications can
  remain briefly stale. Clients carry no freshness cookies or headers.
  Problems snapshots reuse the shared timestamp and retain their age fallback.
  Hyperdrive settings are account-level state, not a `wrangler.jsonc` field;
  inspect them with `wrangler hyperdrive get`. Retain both bindings: strong
  caching disabled, cached binding at 60/15. Rollback is disabling caching on
  `HYPERDRIVE_CACHED` while leaving its binding in place. Deploy server support
  before releasing native cleanup; old clients' freshness headers are ignored.
- **WASM uses `?init`** because `vite-plugin-wasm` doesn't apply to CF's SSR environment. `cfWasmPlugin()` redirects `@cubby/recipebridge` to `recipebridge-cf.ts`.
- **`__CF_WORKERS__` define** eliminates module-level Pool creation from the CF build.
- **Background tasks are self-contained queue messages.** `cubby-background`
  carries the whole task (recipe totals, an embedding refresh, a location AI
  refresh); there is no execution table and no dead-letter queue. Every handler
  re-checks the derived state's own freshness marker (`totalsComputedAt IS
  NULL`, the embedding text hash, the AI fingerprint cache), so duplicate,
  reordered, or redelivered messages are no-ops. Publication after a commit is
  best-effort (`waitUntil`); the stale marker on the source row is the durable
  record of pending work. A lost wakeup is repaired on read (the recipe page
  recomputes a stale recipe before rendering; the product relatedness rail
  polls readiness after "Index now"), by the Problems page's **Awaiting work**
  card ("Settle now" republishes exactly what the counts describe), or by the
  streaming **Repair index** maintenance action. The daily cron refreshes the
  calendar feed and *asserts* the awaiting counts are zero (Sentry when not);
  it never repairs, so a lost wakeup stays visible instead of being absorbed.
  Search projections are written inside the entity write transaction; location
  valuation is a SQL rollup computed on read; the problem-count badge is a KV
  snapshot refreshed behind a read once a mutation marks it dirty; abandoned
  uploads are culled on the next presign.
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

### HTTP API

Create a user-owned `cubby_` key at `/account/api-keys`. Keys grant the owner's
full access, support optional expiration, and use the `http-api` configuration.
They are stored hashed, have no per-key quota or rate limit, and do not create
browser sessions. Revocation takes effect on the next request.

A signed-in browser can open `/api/v1/recipes` directly. Browser and native
session authentication reuse Better Auth's signed session-data cookie for up to
five minutes, then revalidate against the authoritative database. An explicit
`x-api-key` takes precedence, including when invalid. Cookie writes require the
same request Origin; explicit key and bearer credentials need no Origin on
`/api/v1`. Responses retain `Cache-Control: no-store`; database queries follow
the shared household freshness policy independently of authentication caching.

Native clients sign in at `/api/auth/sign-in/email` with
`Origin: cubby-mobile://`, store the signed `set-auth-token` in Keychain, and send
`Authorization: Bearer <token>` with the server-issued session-data cookies.
The API binds cached sessions to the bearer credential and falls back to a
strong authentication lookup on a cache mismatch. Swift keeps automatic cookie
storage disabled and handles only the allowlisted session cache explicitly.
Late responses cannot replace or invalidate a different current credential.
Local sign-out clears native credentials immediately; other cached clients may
continue authenticating until their five-minute cache expires. API keys retain
their existing verification path.

Entity declarations generate capability-dependent resource methods: GET collection,
GET `/{id}`, POST collection, PATCH `/{id}`, and DELETE `/{id}`. POST and PATCH
bodies contain entity fields directly; DELETE needs no body. Create returns 201
and a `Location` header. Other successful methods return 200, and missing details
return 404. Existing deletion guards and cascades apply. For example:

```js
await fetch('/api/v1/recipes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Soup', meta: null, sections: [] }),
});
const query = new URLSearchParams({
  nameFilter: 'Soup',
  page: '1',
  pageSize: '20',
  sort: 'name,-createdAt',
});
await fetch(`/api/v1/recipes?${query}`);
```

Resource lists use 1-based `page` (default 1), `pageSize` (default 10, maximum 500),
and comma-separated `sort` fields (`-` means descending; maximum 3 fields). Filters
are ordinary query parameters (`style: form, explode: true`): text is literal,
numbers and booleans are their plain text form, a list repeats its key
(`tag=a&tag=b`; the bracketed `tag[]=a` and `tag[0]=a` spellings are folded onto
that), and an object-valued filter is flattened onto prefixed scalar parameters
(`projectScopeStatuses`, `projectScopeSearch`, …). Nothing on a URL is
JSON-encoded and nothing needs quoting. `sort` is limited to the entity's
sortable fields and `groupBy` is an enum of its groupable ones (every sortable
field when the entity declares none); both rosters are listed per list
operation in `/api/v1/openapi.json`, and an unknown field is a 400
`INVALID_INPUT` naming it. Unknown parameters are rejected. Pagination metadata
stays zero-based.
For example: `/api/v1/recipes?page=1&pageSize=20&sort=name&nameFilter=Soup`.

Every ordinary operation is one route. A query whose input is flat (scalars,
enums, ISO dates, lists of those) is `GET /api/v1/{domain}/{op}` with one
query parameter per field; a query whose input is structured (nested objects,
the analytics and inspector reads) is `POST /api/v1/{domain}/{op}` with the
input as the JSON body; mutations are `POST` with the JSON body. A scalar
input travels as `input`; a no-input operation takes no parameters. A 2xx body
is the operation output itself and a 4xx/5xx body is the `ApiError` object
(`code`, `message`, optional `reason`, `requestId`, `blockers`,
`validationIssues`) — there is no `{ok, data}` envelope; a query whose output
may be `null` answers 404 instead. Create returns 201 with a `Location`
header. Timestamps are ISO strings. Specialized workflows and bulk actions
remain operation-shaped; streams and the generic entity union operations are
excluded (`http: false` on the contract member). Scalar at `/api/v1/docs` uses
the current browser session and supports explicit keys, which it forgets on
reload. `/api/v1/openapi.json` is an OpenAPI 3.1 document that describes every
auth method, names components after the schema exports they come from
(`ProductTopLevelOut`, `RecipeListPage`, `InventoryScanAtLocationInput`),
spells nullability the way generated clients keep it, carries a
`discriminator` mapping for every discriminated union, and lists each list
operation's sort roster in its `sort` description.

The contract is a real ts-rest router (`apps/web/src/lib/generated/http-contract.gen.ts`,
built from the operation contracts in `apps/web/src/contracts/` and the entity
resource table), served by `@ts-rest/serverless` and documented by
`@ts-rest/open-api`. `createCubbyClient({ baseUrl, apiKey? })` in
`apps/web/src/lib/http-api/client.ts` is a plain `initClient` over it with
same-origin browser credentials: `client.dashboard.counts({ query: {} })`,
`client.resources.vendor.create({ body: { name } })`,
`client.resources.recipe.list({ query: { page: 1, pageSize: 20, sort: "name", nameFilter: "Soup" } })`,
and `client.resources.recipe.update({ params: { id }, body: { notes: 'Updated' } })`.
Run TS scripts with the web tsconfig so schema import aliases resolve. The
native Apple app (`apps/apple`) generates its client from the committed
document and is the API's consumer of record.

After changing contracts, declarations or schemas, run `pnpm generate` (one
generator, `scripts/generator/`, running its entity, start-operation and HTTP
OpenAPI stages in order) and `pnpm generate:check` before a PR; `pnpm check`
includes it. Operation contracts, entity capabilities, and
runtime schemas remain authoritative; new ordinary operations require no
HTTP-specific edits. Wire schemas are derived from the domain schemas by
`toWire` (`apps/web/src/lib/http-api/wire.ts`): Dates become ISO strings, output
transforms must end in concrete schemas, timestamp inputs must accept ISO strings,
query strings coerce numbers, booleans and lists from their text form, and
unsupported JSON representations fail at generation. Component names come from
the exports of `@cubby/schemas` (and the generated entity modules): export a
schema to name it, or give it an explicit `.meta({ id })`.

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

One tool renders an interactive UI in hosts that support the
[MCP Apps extension](https://modelcontextprotocol.io/docs/extensions/apps)
(SEP-1865) — Claude web and desktop among them:

| Tool | App |
|---|---|
| `search_usda_foods` | Pickable cards with data-type richness cues and macros; selection flows back to the agent |

The USDA UI is **strictly additive** — a host without the extension ignores
`_meta.ui.resourceUri` and gets the same `structuredContent` as before. Scope is
deliberately narrow: an app earns its place only where the chat is the right
home for the interaction *and* text is a bad medium for it. Tables, boards, and
charts stay in the web app, one `openLink` away.

`get_shopping_list` remains a plain tool with structured content and readable
text. The removed widget's temporary checkbox state was never durable; durable
manual items and checks belong to the ranked shopping-list project.

Sources live in [apps/mcp-apps/](apps/mcp-apps/) — its own workspace package,
because it's a separate build target with a different runtime (sandboxed iframe,
no React, no Tailwind). It doesn't deploy on its own: it builds to
self-contained HTML that [server/mcp/apps/](apps/web/src/server/mcp/apps/)
inlines and serves as `ui://` resources, driven off the manifest in
[src/metadata.ts](apps/mcp-apps/src/metadata.ts) — the one place an app is
declared. The package build's `--if-stale` mode gates apps/web's `dev`, `test`,
and `build:cf`, rebuilding only when a source is newer than the bundles.

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
- **Browser adapter:** [apps/web/src/entities/usda.functions.ts](apps/web/src/entities/usda.functions.ts).
- Service layer processes USDA portion data through WASM for conversions.

```ts
usdaClient.findFood({ kind: "upc", gtin_upc: "123456789012" });
usdaClient.findFood({ kind: "ndb", ndb_number: 12345 });
usdaClient.listFoods(nameFilter, dataTypeFilter, sort, pagination);
usdaClient.getFoodSummaryByID(fdcId);
```

## 🗺️ Roadmap

The canonical backlog, organized by the kind of work needed next and with
per-item design decisions, is [docs/todos.md](docs/todos.md). Decision-ready
projects, database work, conditional ideas, and operational passes have separate
sections there.

### Recently shipped

- **Product merge** — fold duplicate Product rows into one survivor: stock, ledger lines, external identifiers, images, unit mappings, tasks, project uses, and wishlist candidacies move onto the keeper, same-location stock is summed rather than dropped, and every recipe that costs through a merged-away or deleted product recomputes. Exposed as `merge_products` over MCP; `findDuplicateProductIdentities` (Problems) surfaces candidates by shared identifier-slot evidence (a barcode or a retailer SKU). Built on a shared merge core (`finalizeMerge`) that now underlies all four entity merges (ingredient, vendor, purchase, product) and makes the embedding-cleanup cascade structural rather than a per-merge obligation.
- **Tool wishlist** — a `Wish` entity (`WSH-`) for tracking wanted-but-not-yet-owned items, independent of inventory or projects. Rebuilt on the shared entity/CRUD-factory machinery; the list surfaces each wish's candidate-product cover images and price range, and expands into per-candidate rows the way the Projects Data tab nests sub-projects.
- **Manufacturer spelling snapped on create** — `entity create product` resolves `manufacturer` to the established spelling already used among live Products, closing the drift that let variant spellings accumulate; `entity update product` deliberately does not auto-snap.
- **Financial accounts & transactions** — a settlement evidence layer, `FinancialAccount ──< FinancialTransaction`, separate from spend: statement activity (pending charges, split tender, installments, refunds), allocated across the Purchases it settles so one card line can cover several orders. `Expense.cost` remains the sole spend source; reconciliation compares linked transactions against Expense lines as `unknown`/`pending`/`match`/`mismatch`. Client-parsed Monarch statement preview drives selective, user-approved creation.
- **Typed Expense line roles** — `Expense.lineKind` (`principal`, tax, shipping, discount, fee, tip, other adjustment) distinguishes merchandise/services from productless receipt adjustments, all still summed into `SUM(Expense.cost)`, while excluding adjustment rows from merchandise/category analytics.
- **`ProjectToolUsage`** — a durable, deliberately coarse edge recording that a reusable tool or software Product was used on a project, feeding tool-lifetime-cost and cost-per-project-use rollups without double-counting the original Expense. `/projects/tools` adds a tools × projects matrix (three-state toggle cells, grouped by derived trade or manufacturer) for bulk-backfilling usage history, since attaching one project at a time through a dialog had left the ledger largely empty.
- **Vendor / Purchase / Expense split** — the flat spend ledger became `Vendor ──< Purchase ──< Expense`. The old ledger row is now **`Expense`** (routes `/expenses`, MCP `*_expense(s)` tools); **`Purchase`** is a vendor order/receipt event holding its order id, vendor date, literal never-summed `statedTotal`, and invoice PDF; **`Vendor`** is a real roster. Create/update inputs still take `vendor` (a name) and `orderId` and resolve both on first sight. New operations: `linkExpensesToPurchase`, `splitExpense`, `mergePurchases`.
- **Project tracker migration + maturation** — the household projects/tasks/expenses databases moved from Notion into first-class cubby entities (DB tables, full CRUD UI at `/projects` `/tasks` `/expenses`, MCP tools, dashboard + charts). Follow-ups consolidated the entities onto shared helpers and the entity manifest, added detail pages with full editing UI, wired all three into global search + semantic embeddings, and made them first-class in inline links/hovercards (with mobile dialogs). The one-time import script was removed post-cutover (recoverable from git history).
- **Unified planning calendar** — meals, task ranges, planned/actual expenses, and project spans share filterable month-overview and week-ledger views with a day drawer, quick-add flows, operational summaries, and selective drag-to-reschedule. The Meals calendar tab reuses the same implementation.

### Current and future work

Current and future work is organized by next-step type in the
[canonical backlog](docs/todos.md), alongside each item's design constraints and
promotion triggers. The README deliberately does not mirror the work list.

## 📚 Further Docs

- [AGENTS.md](AGENTS.md) — agent rules, anti-patterns, required helpers
- [apps/web/DESIGN.md](apps/web/DESIGN.md) — visual system, normative tokens, and design guardrails
- [apps/web/AGENTS.md](apps/web/AGENTS.md) — web implementation conventions and failure-prevention rules
- [docs/todos.md](docs/todos.md) — the canonical backlog: goals + load-bearing design decisions + rejected alternatives
- [docs/terminology.md](docs/terminology.md) — glossary disambiguating UI / code / DB names per concept
- [docs/entities.md](docs/entities.md) — entity genericization ledger: the fixed-point thesis, every rejected generic-machinery direction with evidence, and what stays hand-written on purpose
- [docs/inventory-audit.md](docs/inventory-audit.md) — inventory audit/session flow: purpose, current behavior, known gaps, redesign direction
