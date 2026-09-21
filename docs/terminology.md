# 📖 Terminology

A glossary disambiguating Cubby's domain concepts and how each one is named in
the **UI**, in **code/schema**, and in the **database** (Postgres table). The
canonical entity overview lives in [README.md](../README.md#-entities); this doc
exists to resolve the naming drift that the audit flagged — the same concept
sometimes wears three different names across layers.

> **Layering reminder.** Domain compute (costing, availability, conversions)
> lives in Rust/WASM (`recipebridge`), not TS. See [AGENTS.md](../AGENTS.md) for
> where logic belongs. This doc is about *names*, not where logic runs.

## Naming policy

- Entity nouns are always **Vendor**, **Purchase**, and **Expense** in UI copy,
  MCP contracts, and documentation: `Vendor ──< Purchase ──< Expense`.
- A **Purchase** is one vendor order, receipt, or deliberately separate purchase
  event. It is not a card charge; “charge” remains valid only for a
  FinancialTransaction or an ordinary delivery/service charge.
- An **Expense** is the categorized spend line within a Purchase and is the only
  place money lives. “Expense line” or, after that relationship has been made
  explicit, “line” is acceptable shorthand; a bare “line” must not introduce
  the entity on its own.
- An Expense's **line kind** is its receipt role. `principal` means merchandise
  or a service; tax, shipping, discount, fee, tip, and `other_adjustment` remain
  real productless spend lines rather than categories of merchandise.
- A **FinancialTransaction** is settlement evidence (a statement charge, refund,
  payment, or adjustment), never a spend-ledger row. It relates to Purchases
  many-to-many through **Allocations**: one Purchase may have many settlement
  entries, and one real card line may settle several Purchases — a return desk
  processing two orders onto one receipt, or a statement posting one line for
  several same-day refunds.
- An **Allocation** (`FinancialTransactionAllocation`) is how much of one
  transaction settled one Purchase. Evidence only: its amount never enters spend.
  A transaction has either no allocations (unlinked evidence) or a set that sums
  to its amount exactly and shares its sign. Recording a split as two *posted
  transactions* instead is what this replaced — that made the database assert
  card events that never occurred.

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
| Vendor | "Vendor" | `Vendor` / `vendor` | `Vendor` | The roster of places money goes (name unique, website, notes). Identity only — no money. |
| Purchase | "Purchase" | `Purchase` / `purchase` | `Purchase` | One vendor order/receipt event: identity (`vendorId` + optional `orderId`), vendor date, literal never-summed `statedTotal`, and documents. ⚠️ Renamed meaning — see below. |
| Expense | "Expense" | `Expense` / `expense` | `Expense` | A spend-ledger line (actual, or planned via `future`), optionally inside a Project. **All money lives here.** |
| Financial account | "Account" | `FinancialAccount` / `financialAccount` | `FinancialAccount` | A statement/receipt account identity, possibly provisional, with source aliases. |
| Financial transaction | "Transaction" | `FinancialTransaction` / `financialTransaction` | `FinancialTransaction` | Settlement evidence with a signed amount, allocated across zero or more Purchases. Never spend. |
| Merchant | "Merchant" | `merchant` | provider fields on `FinancialTransaction` / `StatementRow` | A provider-supplied settlement label that may name a processor or marketplace. Evidence text, not canonical Vendor identity. |
| Allocation | "Allocation" | `FinancialTransactionAllocation` | `FinancialTransactionAllocation` | How much of one transaction settled one Purchase. Evidence only; never spend. |
| Image | "Image" / "Photo" | `Image` / `image` | `Image` | An R2-backed image linked to a product, location, recipe, project, or purchase (such as its invoice). |

---

## Product vs Ingredient vs InventoryEntry vs USDAFood

These four are the most-confused cluster. They sit on a chain:

```
USDAFood  ←(loose link, fdc_id/barcode)──  Product  ──(optional FK, ingredientId)→  Ingredient
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
  food (`product.fdc_id`, else barcode resolution — `fdc_id` wins).

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
  (resolved at query time, `fdc_id`-first then barcode) — see the USDA notes in
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
- **Home** is the one root location and has `parentId = null`. Every other live
  location is beneath it; omitted/null parent input means a direct child of
  Home. The repo derives the nested structure read-time; there is no materialized
  path column.
- **Unknown** is the staging location directly beneath Home for inventory whose
  physical placement has not been recorded yet.
- InventoryEntries reference leaf-ish locations via `inventoryEntry.locationId`;
  any live location except Home can hold inventory.
- Each location has a printable QR **shortcode** (`LOC-XXXX`). Legacy `L-XXXX`
  labels remain accepted on input only, so previously printed labels still resolve.

---

## Garden

- A **planting** (`Planting`) is one crop instance in at most one `Location`
  (`locationId`, nullable). Its display name is `"<crop name>[ · <variety>]"`.
  There are no lifecycle verbs — Edit is the only hero action, and
  `status`/`locationId`/`finishedOn` are ordinary editable fields. Its state
  reads "Planned", "Growing", or "Finished" (`status`). Sowing in trays and
  transplanting to a bed is `sowedOn` + `transplantedOn` on the same
  planting; its current location may change along the way. A move is editing
  `locationId` — the audit log/timeline is the location history, not a separate
  model. A planting has no photos of its own — see the entry below.
- Nursery stock (bought as a seedling, never sown by the household) carries
  `transplantedOn` only, with `sowedOn` left null. The timeline infers the
  planting's start from `transplantedOn` in that case (`lifecycle.start`'s
  ordered fallback) and marks the interval "Inferred" rather than needing a
  separate origin field.
- An **entry** (`GardenEntry`) is a dated Note or Harvest against a required
  `Location`, explicitly associated with zero or more plantings. The stored
  `kind` enum is `note` / `harvest`, matching its UI label exactly — no
  "observation" or "move" spelling survives. Display name is
  `"<Note|Harvest> · <date> · <area name>"`. The action is "Log entry" (both the
  trigger and the dialog title); editing is "Edit entry". Every entry field,
  including its date,
  Location, and selected Plantings, is freely editable — nothing is
  structural or locked. Entries are the only garden photo surface: a
  planting's list thumbnail borrows its latest entry's photo (falling back
  to its seed Product's image, then nothing).
- Garden dates and amounts read, by context: "Sowed", "Transplanted",
  "Finished", "Planned window" (planting); "Observed" and "Harvest amount"
  (entry).
- A planting's journal is plain "Journal": its explicitly associated entries
  plus unassociated whole-area entries at its current location whose date falls
  within its active window (sowed/transplanted through finished). An entry
  associated with any planting is never inferred into another planting's
  journal from location alone.
- `Location.type` includes `bed` and `planter` (plus `area` for open
  ground), independent of whether the Location links a Product — a
  product-linked raised bed still carries `type: "bed"`; the product supplies
  identity and price, `type` states the form factor. There is no separate
  "growing area" concept in code — whether a location shows
  Plantings/Garden-entries sections is derived from whether it has any, not
  from a stored kind.
- No garden-specific strings module exists on either platform; labels come
  straight from the manifest declaration like every other entity.

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
- **Task** — `task.projectId` is nullable by design; project-less top-level
  open tasks are the Inbox saved filter on `/tasks?view=list` (plus
  promote-to-project).
  `task.trade` is the shared 19-slug trade/costType taxonomy (see
  `TRADE_LABELS`), not free-form text. `taskDependency` mirrors the project
  blocked-by structure.
- **Expense** — the spend ledger (route `/expenses`). `future = true` marks
  planned (not yet actual) spend. Free-text `name` + `cost`, with an optional
  `productId` link (bridge v1) and an optional `purchaseId` naming the Purchase it
  came from. `lineKind = principal` identifies merchandise/services; ancillary
  receipt roles are productless adjustments.

### Inheritance and explicit choices

A stored override records an intentional choice. Normal reads expose the effective
value and carry assignment intent and provenance separately in `fieldResolutions`.
“Use inherited” clears an override; changing a parent/default then updates the
inheriting record. Scalar edits retain explicit-write meaning.

- Principal expense project: own project → purchase default → Household for food →
  Unassigned. A null override means inherit, without an explicit None state.
- Subtask project and “For” product: own value or explicit None → parent task.
  Reparenting follows the new source; detaching preserves effective values.
- Project site names: own names or explicit None → parent’s resolved names.
  Project trade: own default → nearest ancestor default.
- Task trade: own choice → parent task trade when effective projects match →
  effective project default. Principal expense trade: own choice → purchase trade
  default → effective project default. An unresolved required trade blocks writes;
  Other is available only as a deliberate classification.

Equal-to-fallback overrides can be reset when the field declares that policy.
Matching pinned prices and confirmed ownership remain intentional choices.

### Shared purchase charges

Tax, shipping, fees, tips, discounts, and other adjustments require a live purchase
and cannot store a direct project. Their cents are allocated by positive principal
amounts grouped by effective project, including Unassigned. If there are no positive
amounts, absolute negative amounts supply the basis; with no priced nonzero basis,
the purchase project default or Unassigned receives the charge. Planned priced items
participate, and incomplete price coverage remains visible.

Allocation uses deterministic largest remainder and preserves each charge’s sign and
exact cents. The entire purchase sets the denominator before report filters apply.
Project reports sum applicable shares; global spend remains `SUM(Expense.cost)`.
Derived project shares are neither new expenses nor settlement allocations.

CalDAV task creation requires a valid `X-CUBBY-TRADE` property. Clients that cannot
supply classification create the task in Cubby first; edits that omit trade preserve
its existing assignment intent. Individual and bulk discard require an explicit trade.

---

## Vendor vs Purchase vs Expense

> ⚠️ **`Purchase` is the transaction, not the ledger line.** The ledger line — a
> name, a cost, a date, a trade — is **`Expense`**. Any older note, commit
> message, or agent transcript saying "purchase" about a line of spend means
> `Expense`; `Purchase` is the *transaction* the Expense was part of.

```
Vendor ──< Purchase ──< Expense
  │            │  └── documents (PurchaseImage → Image)
  │            └── orderId?, date, statedTotal?
  └── name (unique), website, notes
```

Settlement is a separate axis:

```
FinancialAccount ──< FinancialTransaction >──< Allocation >──< Purchase
```

- **Merchant** (`FinancialTransaction.merchant`, `StatementRow.merchant`) is the
  provider's settlement label. It may name a processor or marketplace rather
  than the place the household bought from, so it is evidence text rather than
  Vendor identity. A Possible vendor suggestion derived from repeated Merchant
  history remains advisory; only an Allocation through a Purchase establishes
  the relationship.

- **Vendor** (`Vendor`) — the roster of places money goes. Name is uniquely
  indexed (live rows). Holds **identity only** — its `spend` and `purchaseCount`
  are correlated rollups, not columns. Deliberately thin: contractor metadata
  (license, COI) and vendor-level documents (W-9, contracts) are the natural
  follow-ons, and would arrive as additive columns.
- **Purchase** (`Purchase`) — one vendor order, receipt, or deliberately separate purchase event.
  `vendorId` is NOT NULL; `orderId` is the vendor's own free-text order/receipt
  id, unique per vendor via a **partial-unique `(vendorId, orderId)` index where
  `orderId IS NOT NULL`** — one order is one Purchase, which is why there is no
  `splitPurchase`. About 40% of Purchases have no order id at all (a contractor's
  progress payment, a farmers-market run).
  - `purchase.date` is the **vendor order/receipt** date; `expense.date` stays the **ledger**
    date that drives monthly buckets and project windows. An invoice dated the
    3rd can clear on the 8th, and they may differ.
  - `statedTotal` is what the paperwork *claimed*, in dollars. It is **never
    summed into spend** — it is purely a reconciliation cue against the Purchase's
    Expenses, and a mismatch is often correct (a partial refund reduces an Expense
    without changing what the purchase paperwork stated). `reconcilePurchase` returns
    `unknown | match | mismatch` as a **soft** flag; nothing rejects a write and
    nothing back-computes a cost from it.
  - A Purchase is **not** a contract or card charge. The contract-level rollup is
    `Project`; installments, shipment billing, split tender, and refunds are
    separate FinancialTransactions linked to the truthful vendor Purchase.
- **Expense** (`Expense`) — the categorized spend line within a Purchase, and **the only place
  money lives**. Every `SUM(cost)` in the codebase reads `Expense` alone.
  `purchaseId` is nullable: a row with no Purchase attached is exactly "no vendor
  recorded", since `purchase.vendorId` is NOT NULL.
  - `lineKind` is `principal | tax | shipping | discount | fee | tip |
    other_adjustment`. Every kind participates in total, monthly, project,
    Purchase-reconciliation, and vendor spend. Cost-type, trade, tool, and
    affinity analytics use only `principal` and expose the signed adjustment
    remainder separately.
  - Non-principal rows cannot link `productId` or `productQuantity`. Historical
    `costType`, trade, and project values remain valid allocation context.
  - `productQuantity` is **signed**, and may be **fractional** — the unit is the
    shelf's unit, so half a conduit coil binned is `-0.5`. Money direction wins,
    and the quantity's own sign is consulted only when there is no money:

    | `cost` | reads as | example |
    | --- | --- | --- |
    | `> 0` | acquisition of `+\|qty\|` | bought 8 outlet boxes |
    | `< 0` | exit of `−\|qty\|` | returned 8, sold one tool |
    | `= 0`, `qty > 0` | free acquisition | promo battery, bundled accessory |
    | `= 0`, `qty < 0` | discard / write-off | thrown away, given away |
    | `< 0`, `qty = 0` | price concession, item KEPT | Amazon "Account adjustment", partial refund for shipping damage |
    | `NULL` | unknown; contributes nothing, reported as uncertainty | old receipt with no count |

    Zero is legal **only** on a negative-cost line — the one direction where
    "money without units" is a real event. It was banned outright until
    2026-08-17, which forced that class to borrow `NULL` and report a known
    quantity as data-entry debt.

    A discard carries **no Purchase** — there is no vendor charge behind
    throwing something away, so `purchaseId` stays null rather than attaching
    to whichever order originally bought it.
  - A principal amount may already include tax. Only an explicitly itemized
    ancillary amount earns its own typed Expense; no tax rate or reconciliation
    difference is used to estimate one.

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
- **MealRecipe (occurrence and preparation).** A `Meal` (a calendar day
  occasion) groups `MealRecipe` rows — each a recipe planned at a numeric
  `scale`, and optionally one physical preparation with expected and measured
  cooked yields. Repeating a Recipe or cooking it twice means two rows. No
  inventory is mutated, and planned meal totals are rolled up read-time as
  `sum(recipe.totals × scale)` (see `meal/helpers.ts`).
- **MealRecipePortion.** A gram amount from one source `MealRecipe`, assigned to
  one member or guest Ledger Party at a target `Meal`. It may target a later
  leftovers Meal; confirmation distinguishes projected from consumed calories.

**Totals.** `Recipe.totals` (cost/calorie rollup) is **persisted** server-side
with a `totalsComputedAt` staleness stamp; lists read the persisted value
rather than recomputing. Meals and portions never persist totals — planned
Meals scale the Recipe's current totals, while portions project the same live
totals through their source preparation's yield.

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
