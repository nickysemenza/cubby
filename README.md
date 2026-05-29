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

## ✨ Capabilities

**Inventory**
- Add/edit/move inventory items across hierarchical locations
- Barcode scan for quick capture (mobile-optimized)
- Bulk edit and move
- Gallery, table, and visualization (treemap, sunburst) views

**Products**
- Specific items (UPC, manufacturer, price, nutrition) or `misc:` placeholders
- Multi-unit mappings (volume ↔ weight ↔ price) for cross-unit conversions
- Optional link to an ingredient and to a USDA food entry

**Recipes**
- Multi-section recipes with nested ingredients
- Ingredients can be other recipes (composition)
- Side-by-side recipe comparison
- Cost rollups via product unit mappings

**USDA**
- Full USDA FoodData Central database loaded into a sibling service
- Browse, search, and link products by UPC or NDB code

**Locations**
- Tree structure (house → room → shelf → bin)
- Interactive graph, treemap, sunburst views
- Printable QR-code shortcode labels

**Images**
- S3/R2-backed image upload with presigned URLs
- Linked to products, locations, or recipes

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
- *Offline support and swipe gestures are planned — see [Roadmap](#-roadmap)*

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
| [apps/usda-api](apps/usda-api) | `@cubby/usda-api` | USDA FoodData Central API — Hono + SQLite | Node | **Fly.io** app `usda-db` (sjc) · <https://usda-db.fly.dev> · SQLite hydrated from R2 (`usda.sqlite.zst`) |

### Packages (internal, not deployed)

| Path | Package | Role | Consumed by |
|---|---|---|---|
| [packages/wasm](packages/wasm) | `@cubby/recipebridge` | WASM bindings — built from `recipebridge/` Rust source via `pnpm run wasm` | `web` |
| [packages/usda-contract](packages/usda-contract) | `@cubby/usda-contract` | ts-rest endpoint contract for the USDA API | `web`, `usda-api` |
| [packages/usda-schemas](packages/usda-schemas) | `@cubby/usda-schemas` | Shared Zod schemas for USDA entities | `web`, `usda-api` |
| [packages/schemas](packages/schemas) | `@cubby/schemas` | Cross-app Zod schemas | `web` |
| [packages/shared](packages/shared) | `@cubby/shared` | Shared utilities | `web` |
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
```

## 🛠️ Development Setup

Prereqs: **Node** (see [.nvmrc](.nvmrc), currently `v24`), **pnpm** (pinned in [package.json](package.json) — `packageManager: pnpm@10.33.4`), **Docker**, **wrangler** (for CF Workers work).

```sh
# 1. Install
pnpm install

# 2. Env
cp apps/web/.env.example apps/web/.env
# Edit apps/web/.env — see "Environment Variables" below

# 3. Local services (Postgres 17 + IntegresQL + Jaeger)
docker-compose up -d

# 4. DB schema
pnpm --filter @cubby/web run db:migrate

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
| `USDA_API_URL` | USDA service URL (defaults to `http://localhost:8080/`) |
| `UPC_LOOKUP_API_URL` / `UPC_LOOKUP_API_KEY` | UPC lookup worker |
| `NOTION_API_KEY` | *(optional)* Project Tracker dashboard |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(optional)* OTLP traces → Jaeger |

## ⚡ Common Commands

| Command | What it does |
|---|---|
| `pnpm run dev` | Start all dev servers (Node, not Workers) |
| `pnpm run check` | Biome (lint + format check) + parallel typecheck |
| `pnpm run typecheck` | Typecheck with `tsgo` (TS 7.0 preview, fast) |
| `pnpm run typecheck:stable` | Typecheck with stable TypeScript (fallback) |
| `pnpm run format:write` | Auto-fix formatting (Biome) |
| `pnpm run test` | Vitest unit + integration |
| `pnpm run test:e2e` | Playwright E2E (uses IntegresQL) |
| `pnpm --filter @cubby/web run db:migrate` | Apply Drizzle migrations |
| `pnpm --filter @cubby/web run build:cf` | Build for Cloudflare Workers |
| `pnpm --filter @cubby/web run preview:cf` | Run the Workers build locally |
| `pnpm --filter @cubby/web run deploy:cf` | Deploy to Cloudflare Workers |
| `pnpm run wasm` | Rebuild `@cubby/recipebridge` from Rust source |

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

What deploys where lives in the [Monorepo Layout](#-monorepo-layout) table. This section covers the non-trivial internals of the main app's CF Workers deploy. (`upc-lookup` is a straightforward CF Worker; `usda-api` is a vanilla Fly.io Dockerfile deploy via `flyctl deploy`.)

The dev server is plain Node via `vite dev`. Production = CF Workers.

| File | Purpose |
|---|---|
| [apps/web/src/cf-server.ts](apps/web/src/cf-server.ts) | Worker entry — wraps each request with `withRequestDb()` |
| [apps/web/src/server/db.ts](apps/web/src/server/db.ts) | Per-request `pg.Client` via `AsyncLocalStorage` (CF) or module-level pool (dev) |
| [apps/web/src/lib/recipebridge-cf.ts](apps/web/src/lib/recipebridge-cf.ts) | WASM wrapper using `?init` pattern for CF |
| [apps/web/wrangler.jsonc](apps/web/wrangler.jsonc) | Worker config (name, vars, Hyperdrive, compat flags) |
| [apps/web/vite.config.ts](apps/web/vite.config.ts) | `cfWasmPlugin()` + `__CF_WORKERS__` define for dead-code elimination |

Key constraints:

- **Hyperdrive** pools TCP connections at CF's edge. The connection string comes from `env.HYPERDRIVE.connectionString` (not a secret). Uses standard `pg.Client`.
- **Per-request `pg.Client`** via `withRequestDb()` + `AsyncLocalStorage`, even though Hyperdrive reuses underlying connections.
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

Visit <http://localhost:3000/api/auth/session> while running the app to inspect the current session.

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

Framed as **Now / Next / Later** (no dates — it's a personal project). Canonical plans live in [docs/plans/](docs/plans/); the links are pointers, not summaries, so they don't rot.

### Now

- **Meal planning + shopping list + recipe scaling** — turns the recipe↔inventory tie into daily utility: plan meals on a calendar, scale recipes, generate shopping lists from shortages, and consume inventory when a meal is cooked → [docs/plans/2025-12-18-meal-planning-bom-design.md](docs/plans/2025-12-18-meal-planning-bom-design.md)

### Next

- **Mobile / offline PWA** — service-worker offline, swipe-to-delete, pull-to-refresh, performance → [docs/plans/2026-01-05-mobile-first-experience-design.md](docs/plans/2026-01-05-mobile-first-experience-design.md)
- **AI deepening** — *"what can I make tonight?"* via a `find_cookable_recipes` MCP tool, smarter Ask Cubby, better photo capture → [docs/todos.md](docs/todos.md)
- **Nutrition & cost intelligence** — price-per-nutrient, daily-value %, and nutrient-density comparisons via WASM conversion extensions → [docs/todos.md](docs/todos.md)
- **Household sharing** — replace the org plugin with a simple shared-household model + magic-link invites (e.g. share with a partner) → [docs/todos.md](docs/todos.md)

### Later

- **Meal planning v2** — expiration-aware suggestions, FEFO consumption, meal templates, nutrition goals
- **WASM deep cuts** — batch recipe parsing, custom unit aliases, inventory depletion preview
- **Location drag-drop** in the tree view
- **Engineering backlog** — replace the CSV import pipeline with direct tRPC calls; document test-placement criteria

## 📚 Further Docs

- [CLAUDE.md](CLAUDE.md) — agent rules, anti-patterns, required helpers
- [docs/style-guide.md](docs/style-guide.md) — Tailwind/CSS conventions
- [docs/todos.md](docs/todos.md) — work list
- [docs/plans/](docs/plans/) — design docs for in-progress / upcoming features
- [docs/combobox-consolidation.md](docs/combobox-consolidation.md) — component consolidation notes
