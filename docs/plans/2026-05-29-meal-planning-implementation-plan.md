# Meal Planning — Implementation Plan

**Status:** Proposed · **Supersedes:** [2025-12-18-meal-planning-bom-design.md](2025-12-18-meal-planning-bom-design.md)

This is the *implementation* plan (sequenced, grounded in the current codebase) for the roadmap's **Now** item. The 2025-12-18 doc is the *design* rationale and is still worth reading for the workflow sketches — but three of its assumptions are stale, corrected below.

---

## What changed since the design doc

The design doc was written against assumptions that no longer (or never did) hold. Verified against the code on 2026-05-29:

| Design doc said | Reality | Consequence |
|---|---|---|
| `Meal.organizationId REFERENCES organization(id)` | **There is no org/tenancy at all.** No `organizationId` column on any table, no Better-Auth organization plugin, no per-user scoping. The whole DB is single-tenant and unscoped. ([schema.ts](../../apps/web/src/server/db/schema.ts), [auth.ts](../../apps/web/src/lib/auth.ts)) | **The household question is moot — nothing to migrate from.** Scope meals like everything else: *no scoping column*. See [Decision: scoping](#decision-scoping). |
| `ALTER TABLE Recipe ADD COLUMN yield` | `recipe.yield` (JSONB `{value, unit}`) **and** `recipe.servings` already exist ([schema.ts:47](../../apps/web/src/server/db/schema.ts)). `RecipeSummaryCard` already shows cost-per-serving. | Recipe-costing / per-serving work (Goal 1) is **mostly done**. Scaling reuses the existing `yield`/`servings`. |
| `convertAmount(...)` from `~/lib/wasm` | No such wrapper. Real API is `wasm.conv_amount_to_kind(mappings, kind, amount)` / `conv_amount_to_unit(...)` ([wasm.ts](../../apps/web/src/lib/wasm.ts), [recipebridge.d.ts](../../packages/wasm/pkg/recipebridge.d.ts)). | Build a thin server-side conversion helper; don't assume the doc's signature. |
| Costing infra is "ready to reuse" | `calculateTotals` is **client-only** — a `.tsx` driven by per-ingredient `useQueries` + USDA enrichment ([univ-conversion.tsx:207](../../apps/web/src/app/_components/units/univ-conversion.tsx)). | The keystone work is **extracting a server-side availability + costing engine.** Everything else builds on it. |

### Decision: scoping

**Meals get no scoping column** (no `userId`, no `householdId`) — matching every other entity in the app. Rationale:

- The app is single-tenant today. Adding scoping to *only* meals creates fake/partial isolation and is inconsistent with Recipe/Product/Inventory/Location.
- "Household sharing" is its own roadmap item. It is a cross-cutting change that should scope **all** entities uniformly (one migration), not get bolted onto meals.
- This **removes the dependency** the design doc implied. Meal planning is no longer blocked on the household model.

If household sharing is later prioritized, `meal`/`mealRecipe` get the same scoping treatment as everything else at that time — no special-casing now.

---

## The keystone: a server-side availability engine

Three roadmap features are the *same computation* — *recipe ingredients vs. inventory on hand, reconciled through WASM unit conversion*:

- "What can I make tonight?" (suggestions UI)
- `find_cookable_recipes` MCP tool (AI / ⌘K)
- "Add missing to shopping list" (shopping list)

Today this can't run server-side and **the agent can't even see recipes** (no recipe MCP tools exist — [server.ts](../../apps/web/src/server/mcp/server.ts) registers inventory/product/location/project tools only). Build the engine once, server-side, and all three fall out.

### What's missing (must build)

- **Traversal helpers** (none exist): ingredient → linked products → inventory entries (summed across locations). The Drizzle relations exist (`relations.product.full` loads `InventoryEntry`; `relations.ingredient.full` loads products + `unitMappings`) but no repo fn walks the chain. ([relations.ts](../../apps/web/src/server/repo/database-helpers/relations.ts))
- **Server-side conversion/costing module** (`.ts`, not `.tsx`): WASM loads fine server-side via `~/lib/wasm` (top-level await; CF via `?init`). Reuse `getAllUnitMappingsFromProduct` ([unit-mapping-utils.ts:172](../../apps/web/src/lib/unit-mapping-utils.ts)). Port the price/weight rollup logic out of `calculateTotals` into a pure function usable on both sides.
- **Coverage calculator**: given a full recipe (`getRecipeByID`) + an inventory snapshot, compute per-ingredient *have vs. need* (convert both to a common unit via WASM), a coverage ratio, and a missing-ingredients list. Handle conversion failures gracefully (treat as "unknown", surface in a `missing`/`unconvertible` list — same shape as `calculateTotals.missingByType`).

### Reusable building blocks (already exist)

| Function | Location | Use |
|---|---|---|
| `getRecipeByID(db, id)` | [repo/recipe/crud.ts:65](../../apps/web/src/server/repo/recipe/crud.ts) | Full nested recipe (sections → ingredients → amounts) |
| `recipeList(...)` | [repo/recipe/crud.ts:122](../../apps/web/src/server/repo/recipe/crud.ts) | Enumerate recipes to rank |
| `getAllUnitMappingsFromProduct(product)` | [unit-mapping-utils.ts:172](../../apps/web/src/lib/unit-mapping-utils.ts) | Merge product + USDA-derived mappings |
| `wasm.conv_amount_to_kind / conv_amount_to_unit` | [wasm.ts](../../apps/web/src/lib/wasm.ts) | Graph unit conversion (cups→g→$) |
| `withTransaction`, `updateAndReturn`, `insertAndReturn`, `notDeleted` | [repo/database-helpers](../../apps/web/src/server/repo/database-helpers) | Repo plumbing |
| `Amount` type `{value, unit}` | [codec.ts:26](../../packages/schemas/src/codec.ts) | Shared across recipe amounts, inventory, mappings |

---

## Phased plan

Front-loads the north-star value: **Phases 0–1 ship "what can I make?" (UI + AI) before any calendar/CRUD.**

### Phase 0 — Availability engine (server-side foundation) ⭐ keystone — ✅ DONE

No user-facing surface; everything below builds on it. Shipped:

- **Costing core relocated** `univ-conversion.tsx` → [`~/lib/recipe-costing.ts`](../../apps/web/src/lib/recipe-costing.ts). It was already React-free, so `git mv` preserved history; 11 importers + the unit test were repointed. Server code now reuses `safeConvertAmount`/`calculateTotals` without reaching into `app/_components`.
- **Traversal helper** `getInventoryForProducts(db, productIds)` in [`repo/inventory/crud.ts`](../../apps/web/src/server/repo/inventory/crud.ts). (`getProductsForIngredient` proved unnecessary — `IngredientService.getIngredientByID` already returns food-enriched products with mappings.)
- **`AvailabilityService.getRecipeAvailability(recipeId)`** in [`server/services/availability.service.ts`](../../apps/web/src/server/services/availability.service.ts), wired into the tRPC context as `ctx.services.availability` (ready for the Phase 1 router). Per ingredient it returns `{ status: ok|short|missing|unconvertible|subrecipe, need, basisUnit, needValue, haveValue }`, plus a recipe-level `coverage`.
- **Tests** ([`availability.integration.test.ts`](../../apps/web/src/server/services/availability.integration.test.ts), IntegresQL): ok / short / missing / unconvertible, including the cup→gram hop. Green; `format` + `typecheck` clean.

**Key design finding — reconcile in grams, not the need's unit.** WASM density bridges are *one-directional* (`cup → g` works; `g → cup` and `conv_amount_to_unit` throw). So the engine converts both the need and the on-hand amounts to **weight (grams)** — the same basis the existing costing uses — and falls back to an exact-unit match for non-weight items (e.g. count goods whose product has only a price mapping). This also shapes Phase 3's shopping-list math.

**Still to validate:** that WASM conversion runs in the `preview:cf` Workers build, not just Node/Vitest (see Risks).

### Phase 1 — "What can I make?" + AI (early wins) 🎯

Falls directly out of Phase 0.

1. **`suggestions` router** (new, [root.ts](../../apps/web/src/server/api/root.ts) registration):
   - `suggestions.getRecipeAvailability({ recipeId })` → single-recipe coverage.
   - `suggestions.getMakeable({ minCoverage?, limit? })` → recipes ranked by coverage, each with missing list. (Read-only `query` procedures.)
2. **UI**: `/meals/suggestions` route ([routes/_authenticated/](../../apps/web/src/routes/_authenticated/)) — recipe cards with a coverage badge ("Ready" / "Missing 2") + filter. Mirror the `EntityLayout` + list patterns from [locations.index.tsx](../../apps/web/src/routes/_authenticated/locations.index.tsx).
3. **MCP / agent tools** ([server.ts](../../apps/web/src/server/mcp/server.ts)) — handlers wrap the tRPC `caller` (e.g. `caller.suggestions.getMakeable(...)`):
   - `list_recipes`, `get_recipe` — **the agent currently can't see recipes at all**; add these regardless.
   - `find_cookable_recipes` → `caller.suggestions.getMakeable`. The `find_`/`list_`/`get_` prefixes auto-pass the read-only allowlist ([mcp-bridge.ts:18](../../apps/web/src/server/agent/mcp-bridge.ts)) — no allowlist edit needed.
4. **Tests**: router integration test; the existing `runtime.unit.test.ts` already allowlists `find_cookable_recipes` — wire the real tool.

**Exit criteria:** "what can I make tonight?" works from both `/meals/suggestions` and the ⌘K agent.

### Phase 2 — Meal calendar + scaling

1. **Schema** ([schema.ts](../../apps/web/src/server/db/schema.ts)): `meal` (`id`, `date`, soft-delete cols) and `mealRecipe` (`id`, `mealId`, `recipeId`, `scale` numeric default 1, soft-delete cols) + indexes + Drizzle relations. **No scoping column** (see [decision](#decision-scoping)). Migration via `db:migrate`.
2. **Plumbing**: branded `mealId`/`mealRecipeId` + `unsafe*Id` ([identifiers.ts](../../packages/schemas/src/identifiers.ts)); add `"meal"` to the entity enum ([entity.ts](../../packages/schemas/src/entity.ts)); `queryKeys.meal` ([query-keys.ts](../../apps/web/src/lib/query-keys.ts)).
3. **Repo + router**: `repo/meal/` (crud.ts/helpers.ts) using `insertAndReturn`/`withTransaction`; `meal` router via `createEntityCrudProcedures` ([crud-factory.ts:216](../../apps/web/src/server/api/crud-factory.ts)) + custom procedures: `getByDate`, `addRecipe`, `updateRecipe` (scale), `removeRecipe`.
4. **UI**: `/meals` (week calendar) + `/meals/$date` (day detail) following the list/detail route patterns; "Add to Meal ▼" dropdown on [recipes.$id.tsx](../../apps/web/src/routes/_authenticated/recipes.$id.tsx) (Today / Tomorrow / pick date).
5. **Scaling**: apply `mealRecipe.scale` to ingredient amounts; reuse existing `yield`/`servings` for per-serving display.

**Exit criteria:** plan a recipe onto a day at 2× scale; see it in the calendar; scaled cost shows.

### Phase 3 — Shopping list

1. `meal.getShoppingList({ from, to })`: aggregate scaled ingredient needs across meals in range, subtract inventory-on-hand via the **Phase 0 engine**, return shortages (`need` / `have` / `buy`).
2. `/meals/shopping-list` page: date-range picker + shortage table; "add missing" entry point reuses the same coverage output as Phase 1.

**Exit criteria:** a week of planned meals produces a correct buy-list net of current inventory.

### Phase 4 — Cook / consume inventory

1. `meal.markCooked({ mealId })`: for each scaled ingredient, convert recipe amount → inventory unit (WASM), deduct across entries in a `withTransaction`, delete entries that hit zero, write audit logs ([audit-log.ts](../../apps/web/src/server/repo/audit-log.ts)). Edge cases per design doc §4: no inventory → log shortfall; conversion fail → skip + warn.
2. **Tests**: `integration.test.ts` asserting atomic deduction + audit entries + partial/missing/conversion-fail paths.

**Exit criteria:** marking a meal cooked atomically decrements inventory and is fully audited; failures don't leave partial state.

---

## Out of scope (v1)

Per design doc: price-history, location-preference consumption ("kitchen first"), meal labels (breakfast/lunch/dinner), recurring meals, partial cooking, expiration/FEFO, aisle mapping. Household scoping is explicitly **not** part of this (own roadmap item).

## Risks / watch-items

- **WASM on Cloudflare Workers server path** — confirm `conv_amount_to_*` runs in the `preview:cf` build, not just Node dev (the `?init` redirect + `__CF_WORKERS__` define). Validate early in Phase 0.
- **Costing divergence** — extract the pure core so client `calculateTotals` and the server engine share one implementation; don't fork the rollup math.
- **Performance of `getMakeable`** — ranking all recipes × ingredients × inventory could be heavy. Batch inventory fetches (Phase 0 helper), cap/scope the candidate set, and add a coverage threshold filter.

## Suggested follow-ups (not in this plan)

- README "Now" pointer currently targets the 2025-12-18 design doc — repoint to this plan.
- The design doc's v2 list (expiration-aware suggestions, FEFO, meal templates, nutrition goals) maps to the roadmap's "Meal planning v2 / Later".
