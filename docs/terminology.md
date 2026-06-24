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
| Image | "Image" / "Photo" | `Image` / `image` | `Image` | An R2-backed image linked to a product, location, or recipe. |

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
