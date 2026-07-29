# 📖 Terminology

A glossary disambiguating Cubby's domain concepts and how each one is named in
the **UI**, in **code/schema**, and in the **database** (Postgres table). The
canonical entity overview lives in [README.md](../README.md#-entities); this doc
exists to resolve the naming drift that the audit flagged — the same concept
sometimes wears three different names across layers.

> **Layering reminder.** Domain compute (costing, availability, conversions)
> lives in Rust/WASM (`recipebridge`), not TS. See [CLAUDE.md](../CLAUDE.md) for
> where logic belongs. This doc is about *names*, not where logic runs.

---

## Core entities

| Concept | UI label | Code / schema name | DB table | One-liner |
|---|---|---|---|---|
| Product | "Product" | `Product` / `product` | `Product` | A purchasable item (a specific SKU or a `misc:` placeholder). |
| Ingredient | "Ingredient" | `Ingredient` / `ingredient` | `Ingredient` | A canonical recipe-line concept ("flour"), independent of any SKU. |
| Inventory entry | "Inventory" / "Inventory item" | `InventoryEntry` / `inventoryEntry` | `InventoryEntry` | A quantity of one Product at one Location. |
| USDA food | "USDA food" / "Nutrition" | `USDAFood` / `usda_food` | external (USDA service) | A FoodData Central reference food, loosely linked to a Product. |
| Location | "Location" | `Location` / `location` | `Location` | A node in the physical storage tree (house → room → shelf → bin). |
| Recipe | "Recipe" | `Recipe` / `recipe` | `Recipe` | A cookable thing with sections of ingredients; can itself be an ingredient. |
| Section | "Section" | `RecipeSection` / `recipeSection` | `RecipeSection` | An ordered group of ingredient lines within a recipe ("For the sauce"). |
| Recipe-section ingredient | (a row in a recipe) | `RecipeSectionIngredient` | `RecipeSectionIngredient` | One ingredient line: ingredient + amounts + raw line + modifier. |
| Meal | "Meal" | `Meal` / `meal` | `Meal` | A planned eating occasion on a calendar day; groups recipes. |
| Meal recipe | (a recipe inside a meal) | `MealRecipe` / `mealRecipe` | `MealRecipe` | A recipe planned into a meal at a `scale` multiplier. |
| Cookbook | "Cookbook" | `Cookbook` / `cookbook` | `Cookbook` | A first-class recipe *source* — the book an EPUB-extracted recipe set came from. |
| Project | "Project" | `Project` / `project` | `Project` | A household undertaking (furniture, renovation, …) grouping Tasks and Expenses; blocked-by edges to other Projects. |
| Task | "Task" | `Task` / `task` | `Task` | A unit of work, optionally inside a Project; blocked-by edges to other Tasks. |
| Vendor | "Vendor" | `Vendor` / `vendor` | `Vendor` | The roster of places money goes (name unique, `kind`, website, notes). Identity only — no money. |
| Purchase | "Purchase" / "Charge" | `Purchase` / `purchase` | `Purchase` | **ONE vendor transaction.** Identity (`vendorId` + optional `orderId`), charge date, an optional never-summed `statedTotal`, and its documents. ⚠️ Renamed meaning — see below. |
| Expense | "Expense" | `Expense` / `expense` | `Expense` | A spend-ledger line (actual, or planned via `future`), optionally inside a Project. **All money lives here.** |
| Image | "Image" / "Photo" | `Image` / `image` | `Image` | An R2-backed image linked to a product, location, recipe, project, or purchase (a charge's invoice). |

---

## Product vs Ingredient vs InventoryEntry vs USDAFood

These four are the most-confused cluster. They sit on a chain:

```
USDAFood  ←(loose link, fdc_id/UPC)──  Product  ──(optional FK, ingredientId)→  Ingredient
                                          │
                                          └─(inventoried as)→  InventoryEntry  ──(at)→  Location
```

- **Product** (`Product`) — a *purchasable* item. Two kinds:
  - **Specific item** — has UPC, manufacturer, price, nutrition (created via
    barcode scan).
  - **Misc collection** — an opaque placeholder, name only, prefixed `misc:`.

  A Product carries the unit mappings (`ProductUnitMappings`: an `a = b` amount
  pair) that drive cross-unit/price conversions. A Product may point to **one**
  Ingredient (`product.ingredientId`) and may be loosely linked to **one** USDA
  food (`product.fdc_id`, else UPC resolution — `fdc_id` wins).

- **Ingredient** (`Ingredient`) — the canonical recipe-line concept, SKU-free.
  "Flour" is one Ingredient no matter which brand of flour is on the shelf.
  Many Products can point to one Ingredient. An Ingredient whose `recipeId` is
  set *is* a recipe (recipe-as-ingredient / sub-recipe composition). Names are
  case-insensitively unique; `aliases` and `naKinds` (coverage opt-out) hang
  off it.

- **InventoryEntry** (`InventoryEntry`) — a physical fact: `amount` of one
  Product at one Location. Unique per `(productId, locationId)`. Carries a
  precomputed `valuation` (`amount.value × product.price`). **Not** the same as
  a Product: the Product is the *what*, the InventoryEntry is the *how much,
  where*.

- **USDAFood** (`usda_food`) — nutrition reference data from USDA FoodData
  Central, served by the sibling `usda-api` worker (not a row in the main DB).
  Linked to a Product for nutrition/cost intelligence; the link is *loose*
  (resolved at query time, `fdc_id`-first then UPC) — see the USDA notes in
  README.

**Rule of thumb:** Recipes reference **Ingredients**; the pantry holds
**InventoryEntries of Products**; **USDA** supplies nutrition. The Product is
the bridge between the recipe world (via `ingredientId`) and the physical/cost
world (via inventory + price + USDA).

---

## Location hierarchy

A single self-referential tree (`Location`, `location.parentId` → `Location`):

```
House  →  Room  →  Shelf  →  Bin
```

- The shape is a tree, not fixed levels — `location.type` is free text ("house",
  "room", "shelf", "bin", …); depth is whatever the `parentId` chain produces.
- A root location has `parentId = null`. The repo's `buildLocationTree` /
  `buildLocationTypeCount` derive the nested structure read-time; there is no
  materialized path column.
- InventoryEntries reference leaf-ish locations via `inventoryEntry.locationId`,
  but any location can hold inventory.
- Each location has a printable QR **shortcode** (`L-XXXX`).

---

## Project tracker (Project / Task / Expense)

The household project tracker (migrated from Notion) is a self-contained module:

- **Project** — groups Tasks and Expenses. `projectDependency` rows are
  blocked-by edges between projects ("blocking" is the reverse read).
  `project.locations` is deliberately a free-form `text[]` of house/site names —
  **not** an FK to the `Location` entity (that tree is physical storage).
  Images attach via the `ProjectImage` join table to the shared `Image` entity.
  Spend/progress rollups (`spent`, task counts) are SQL aggregates, never
  denormalized.
- **Task** — `task.projectId` is nullable by design; project-less tasks are
  "inbox" tasks (shipped: `/tasks?view=inbox` + promote-to-project).
  `task.trade` is the shared 19-slug trade/costType taxonomy (see
  `TRADE_LABELS`), not free-form text. `taskDependency` mirrors the project
  blocked-by structure.
- **Expense** — the spend ledger (route `/expenses`). `future = true` marks
  planned (not yet actual) spend. Free-text `name` + `cost`, with an optional
  `productId` link (bridge v1) and an optional `purchaseId` naming the charge it
  came from.

---

## Vendor vs Purchase vs Expense

> ⚠️ **`Purchase` changed meaning.** It used to *be* the ledger line — a name, a
> cost, a date, a trade. That row is now **`Expense`**. Any older note, commit
> message, or agent transcript saying "purchase" about a line of spend means
> `Expense`. `Purchase` today is the *transaction* the line was part of.

```
Vendor ──< Purchase ──< Expense
  │            │  └── documents (PurchaseImage → Image)
  │            └── orderId?, date, statedTotal?
  └── name (unique), kind, website, notes
```

- **Vendor** (`Vendor`) — the roster of places money goes. Name is uniquely
  indexed (live rows), `kind` is `retailer|contractor|supplier|other` and
  nullable (the backfill can't infer it; guessing is worse than blank). Holds
  **identity only** — its `spend` and `purchaseCount` are correlated rollups, not
  columns. Deliberately thin in v1: contractor metadata (license, COI) and
  vendor-level documents (W-9, contracts) are the natural follow-ons.
- **Purchase** (`Purchase`) — **ONE vendor transaction**, i.e. a charge.
  `vendorId` is NOT NULL; `orderId` is the vendor's own free-text order/receipt
  id, unique per vendor via a **partial-unique `(vendorId, orderId)` index where
  `orderId IS NOT NULL`** — one order is one charge, which is why there is no
  `splitPurchase`. About 40% of charges have no order id at all (a contractor's
  progress payment, a farmers-market run).
  - `purchase.date` is the **charge** date; `expense.date` stays the **ledger**
    date that drives monthly buckets and project windows. An invoice dated the
    3rd can clear on the 8th, and they may differ.
  - `statedTotal` is what the paperwork *claimed*, in dollars. It is **never
    summed into spend** — it is purely a reconciliation cue against the charge's
    lines, and a mismatch is often correct (a partial refund reduces a line
    without changing what the charge stated). `reconcilePurchase` returns
    `unknown | match | mismatch` as a **soft** flag; nothing rejects a write and
    nothing back-computes a cost from it.
  - A charge is **not** a contract: 11 progress payments to one contractor are
    **11 purchases**, not one. The contract-level rollup already exists and is
    `Project`. Nor is it guaranteed 1:1 with a *card charge* — Amazon bills per
    shipment; that's the deferred `Payment` axis.
- **Expense** (`Expense`) — the categorized line of spend, and **the only place
  money lives**. Every `SUM(cost)` in the codebase reads `Expense` alone.
  `purchaseId` is nullable: a row with no charge attached is exactly "no vendor
  recorded", since `purchase.vendorId` is NOT NULL.

**API shape vs. columns.** `expense.vendor` and `expense.orderId` are no longer
columns, but `expenseOut` still exposes both (resolved through
`expense.purchaseId → Purchase → Vendor`) and adds `purchaseId` + `vendorId`.
Create/update inputs still **accept `vendor` as a plain name string** plus
`orderId`, and the repo resolves them via `findOrCreateVendor` +
`findOrCreatePurchase` inside the caller's transaction — which is what keeps MCP,
quick-add, and the purchase-import skill unchanged across the split. The ledger's
vendor *filter*, by contrast, is now `vendorId`-based, not a free-text match.

**Operations** (`repo/purchase.ts`): `linkExpensesToPurchase` (one invoice
spanning trades), `splitExpense` (replaces the old `(combo, saw portion)` row-name
convention), `mergePurchases` (groups the order-less singletons the backfill
couldn't join; refuses across vendors and refuses when both sides carry a
non-null order id).

---

## Recipe / Section / MealRecipe

Two different "a recipe inside something" relationships — don't conflate them:

- **Recipe → Section → ingredient line.** A `Recipe` has ordered
  `RecipeSection`s; each section has ordered `RecipeSectionIngredient` rows
  (ingredient + `amounts` + `rawLine` + `modifier`). This is the recipe's own
  structure.
- **Recipe-as-ingredient (composition).** When an `Ingredient.recipeId` is set,
  that ingredient *is* a sub-recipe; using it in another recipe's section nests
  one recipe inside another. Costing memoizes sub-recipes (with a cycle guard).
- **MealRecipe (planning).** A `Meal` (a calendar day occasion) groups
  `MealRecipe` rows — each a recipe planned at a numeric `scale`. This is
  *planning only*: no inventory is mutated, and meal totals are rolled up
  read-time as `sum(recipe.totals × scale)` (see `meal/helpers.ts`).

**Totals.** `Recipe.totals` (cost/calorie rollup) is **persisted** server-side
with a `totalsComputedAt` staleness stamp; lists read the persisted value
rather than recomputing. Meals never persist totals — they always scale the
recipe's.

---

## "capture" vs "import" vs "enrich"

Three verbs that all *bring data in* but mean different things:

- **Capture** — quick, manual, first-party data entry, usually mobile. The
  canonical case is **barcode scan → quick-create a Product / InventoryEntry**.
  Capture is about *you* recording what you physically have. (UI: "scan",
  "quick add".)
- **Import** — pulling a *recipe* in from an external source and converting it
  into Cubby's shape (`ImportRecipe → RecipeCreateInput`, then upsert). Sources
  are tagged via `Recipe.SourceType` (the `RecipeSource` enum) — see below.
  Code: `import-recipe-convert.ts`, `upsertImportRecipe`, the `import_recipe`
  MCP tool.
- **Enrich** — the optional **service layer** augmenting an entity with derived
  / external data *after* it exists (the architecture's
  `Router → Service (enrichment) → Repo`). The canonical case is decorating a
  Product with USDA nutrition or running portion data through WASM. Enrichment
  never owns the row; it adds to it.

| Verb | Direction | Owns the row? | Typical trigger |
|---|---|---|---|
| Capture | user → DB | yes (creates it) | barcode scan, quick add |
| Import | external source → DB | yes (creates it) | recipe scrape / EPUB / Notion |
| Enrich | external/derived → existing row | no (decorates) | USDA link, WASM conversion |

---

## Recipe source (provenance)

`Recipe.SourceType` (the `RecipeSource` enum) tags where a recipe came from; the
`source.ts` codec turns the DB column triple
(`SourceType` / `SourceData` / `cookbookId`) into a tagged provenance union for
the API. Values:

| `SourceType` | Meaning | `SourceData` holds | `cookbookId` |
|---|---|---|---|
| `Website` | Scraped/imported from a URL | the source URL | null |
| `Book` | Extracted from a cookbook EPUB | the cookbook name | set (FK → `Cookbook`) |
| `Notion` | Synced from a Notion page | the Notion page id | null |
| `Other` | No identifiable source | null | null |

`SourceData` is kept synced to the cookbook name for `Book` recipes so the codec
stays a pure recipe-row read.

---

## Cookbook (the source) vs cookbook (the physical book)

- **`Cookbook` (entity)** — a digital recipe *source*: the EPUB-extracted set,
  its assembled `ImportRecipe[]` JSON (so recipes can be re-derived without
  re-running the LLM), OPF metadata, and a cover image. `Book` recipes FK to it.
- The **physical book on a shelf** would be a `Product` / `InventoryEntry`, and
  is **deliberately not linked** to the `Cookbook` entity — the digital source
  and the physical object are kept separate by design.
