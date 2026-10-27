# 📖 Terminology

A glossary disambiguating Cubby's domain concepts and how each one is named in
the **UI**, in **code/schema**, and in the **database** (Postgres table). The
canonical entity overview lives in [README.md](../../README.md#entities); this doc
resolves concepts whose names differ across layers.

## Naming policy

- Entity nouns are always **Vendor**, **Purchase**, and **Expense** in UI copy,
  MCP contracts, and documentation: `Vendor ──< Purchase ──< Expense`.
  **Brand** labels the Vendor a Product is marketed under; **Seller** labels the
  Vendor that supplied a Purchase. They are roles of the same entity.
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
  `unclassified` means the amount is recorded but its receipt role is unresolved.
- **Logistics** is delivery, pickup, transport, hauling, storage, and job-site
  coordination, regardless of the trade served. Appliance delivery is logistics;
  appliance installation is appliances.
- A **Garden project** grows or cares for plants. A **Renovation project**
  changes a room, structure, or permanent outdoor infrastructure, including
  paving, retaining walls, and irrigation infrastructure.
- A **Workshop project** builds or maintains shop infrastructure, including
  workbenches, jigs, and tool storage. These fixtures are workshop projects
  rather than furniture projects.
- A **FinancialTransaction** is settlement evidence (a statement charge, refund,
  payment, or adjustment), never a spend-ledger row. It relates to Purchases
  many-to-many through **Allocations**: one Purchase may have many settlement
  entries, and one real card line may settle several Purchases — a return desk
  processing two orders onto one receipt, or a statement posting one line for
  several same-day refunds.
- A **Source transaction record** (`SourceTransactionRecord`, `STR-`) is one
  retained provider observation or revision, including pending, withdrawn,
  incoming and zero-value evidence. It is distinct from a canonical
  FinancialTransaction and never adds spend. Equal-looking observations do not
  by themselves prove one charge.
- A **Transaction import** (`TransactionImport`, `TIM-`) is one immutable source
  collection: a file or bounded MCP snapshot, including resumed chunks. Membership
  does not establish complete account/window coverage or completed reconciliation.
- **Financial evidence** is the area containing Source transaction records and
  Transaction imports. Use those entity labels across clients; statement rows
  and batches describe source formats or transport, not replacement entity names.
- An **Allocation** (`FinancialTransactionAllocation`) is how much of one
  transaction settled one Purchase. Evidence only: its amount never enters spend.
  A transaction has either no allocations (unlinked evidence) or a set that sums
  to its amount exactly and shares its sign. Recording a split as two _posted
  transactions_ instead is what this replaced — that made the database assert
  card events that never occurred.

---

## Core entities

The [entity overview](../../README.md#entities) owns entity definitions.
Declarations own field and storage names. The UI aliases that need explaining
here are **Inventory** for `InventoryEntry`, **Account** for `FinancialAccount`,
**Transaction** for `FinancialTransaction`, and **USDA food** for an external
FoodData Central record. **Merchant** is provider evidence text, never a Vendor.

---

## Product vs Ingredient vs InventoryEntry vs USDAFood

These four are the most-confused cluster. They sit on a chain:

```
USDAFood  ←(loose link, fdc_id/barcode)──  Product  ──(optional FK, ingredientId)→  Ingredient
                                          │
                                          └─(inventoried as)→  InventoryEntry  ──(at)→  Location
```

- **Product** (`Product`) — a _purchasable_ item. Two kinds:
  - **Specific item** — can record a Brand, UPC, price and nutrition (created via
    barcode scan).
  - **Misc collection** — an opaque placeholder, name only, prefixed `misc:`.

  A Product carries the unit mappings (`ProductUnitMapping`: an `a = b` amount
  pair, stored as `aValue/aUnit/bValue/bUnit`) that drive cross-unit/price conversions. A Product may point to **one**
  Ingredient (`product.ingredientId`) and may be loosely linked to **one** USDA
  food (`product.fdc_id`, else barcode resolution — `fdc_id` wins).

- **Ingredient** (`Ingredient`) — the canonical recipe-line concept, SKU-free.
  "Flour" is one Ingredient no matter which brand of flour is on the shelf.
  Many Products can point to one Ingredient. An Ingredient whose `recipeId` is
  set _is_ a recipe (recipe-as-ingredient / sub-recipe composition). Names are
  case-insensitively unique; `aliases` and `naKinds` (coverage opt-out) hang
  off it.

- **InventoryEntry** (`InventoryEntry`) — a physical fact: `amount` of one
  Product at one Location. Unique per Product, Location, placement, and
  ownership (mode and owner), so a member's copy and another's are separate
  entries. Its
  `amount` is stored as `amountValue/amountUnit`; its `valuation` is computed on
  every read (the amount routed through the Product's unit mappings to its
  current price). **Not** the same as
  a Product: the Product is the _what_, the InventoryEntry is the _how much,
  where_.

- **USDAFood** (`usda_food`) — nutrition reference data from USDA FoodData
  Central, served from the active USDA release (not a row in the main DB).
  Linked to a Product for nutrition/cost intelligence; the link is _loose_
  (resolved at query time, `fdc_id`-first then barcode) — see the USDA bullet in
  [development](../development.md#architecture).

- **USDA release** — one immutable FoodData Central publication (identified by
  its publication date, e.g. `2026-04`) that Cubby serves in full. Exactly
  one is the **active USDA release** at a time; a USDA food's record never
  changes within a release. Not "edge version" or "dataset version".

- **Food revision** — FoodData Central republishes a branded food under a new
  `fdc_id` each time its label data changes; every such `fdc_id` is one
  revision of the same barcoded food. The **current revision** is the most
  recently published one in the active USDA release, and a link to any older
  revision means the current one. Non-branded foods have a single revision.

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
- Each location has a printable QR **shortcode** (`LOC-XXXXX` for new codes).
  Existing four-character codes and legacy `L-XXXX` labels remain accepted on
  input, so previously printed labels still resolve.

---

## Garden

- A **plant** (`Plant`) is a cultivar or species; its `gardenGuideKey` is the
  crop and its display name is `"<name> · <crop label>"`. It carries the
  household's `verdict` ("Yes", "Maybe", "No").
- A **planting** (`Planting`) is one instance of a Plant in at most one `Location`
  (`locationId`, nullable). Its display name is its Plant's.
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

- **Project** — groups Tasks and Expenses. `projectDependency` links are
  blocked-by edges between projects ("blocking" is the reverse read).
  `project.locations` is deliberately a free-form `text[]` of house/site names —
  **not** an FK to the `Location` entity (that tree is physical storage).
  Images attach through `EntityAttachment` rows to the shared `Image` entity.
  Spend/progress rollups (`spent`, task counts) are SQL aggregates, never
  denormalized.
  Kind follows the work: standalone home maintenance, repair, and replacement
  are Household; remodeling a room or structure is Renovation. A room name
  alone does not make maintenance a renovation.
- **Task** — `task.projectId` is nullable by design; project-less top-level
  open tasks are the Inbox saved filter on `/tasks?view=list` (plus
  promote-to-project).
  `task.trade` is the shared trade/costType taxonomy (see
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
- Task assignee: own member or explicit None → parent task’s effective assignee →
  effective project default → Unassigned. A parent’s explicit None also stops
  fallback. Project default assignee: own member or explicit None → parent
  project’s resolved default → Unassigned. `assigneeId` references a live
  LedgerParty of kind member, independently of a linked login; `assigneeMode`
  records inherit or explicit. Scalar null writes mean None; Use inherited
  clears the stored reference. Reparenting follows the new source and detaching
  preserves the effective assignee. My tasks matches the acting login’s linked
  member; a login without a linked live member matches no tasks.
- Project site names: own names or explicit None → parent’s resolved names.
  Project trade: own default → nearest ancestor default.
- Task trade: own choice → nearest ancestor task trade while ancestors share
  the task's effective project → effective project default. Principal expense trade: own choice → purchase trade
  default → effective project default. Adjustment expense trade: own choice →
  its principals' trades through the joint allocation. An unresolved required trade blocks writes;
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

A Purchase is the vendor order/receipt event; an Expense is its spend line.
Historical notes sometimes use Purchase for what is now Expense.

```
Vendor ──< Purchase ──< Expense
  │            │  └── documents (EntityAttachment → Image)
  │            └── orderId?, date, statedTotal?
  └── name (unique), website, notes
```

Settlement is a separate axis:

```
FinancialAccount ──< FinancialTransaction >──< Allocation >──< Purchase
```

- **Merchant** (`FinancialTransaction.merchant`, `SourceTransactionRecord.merchant`) is the
  provider's settlement label. It may name a processor or marketplace rather
  than the place the household bought from, so it is evidence text rather than
  Vendor identity. A Possible vendor suggestion derived from repeated Merchant
  history remains advisory; only an Allocation through a Purchase establishes
  the relationship.

- **Vendor** (`Vendor`) — a canonical identity used for marketed brands and
  purchase sellers. Separate Vendors can share a name; a name or alias alone
  does not establish that they are the same identity. Its `spend` and
  `purchaseCount` are rollups through Purchases, not stored money.
- **Brand** — the Vendor under whose name a Product is marketed. It can differ
  from both the physical manufacturer and the Seller that supplied a Purchase.
- **Seller** — the Vendor that supplied a Purchase. The same Vendor may also be
  a Product's Brand, but either role can exist independently.
- **Generic / Unbranded** — the explicitly selected Brand for a Product known
  to be unbranded. It is different from an unknown Brand and does not establish
  that the Product is a commodity; it cannot be a Seller or have a VendorAccount.
- **Purchase** (`Purchase`) — one vendor order, receipt, or deliberately separate purchase event.
  `vendorId` is NOT NULL; `orderId` is the vendor's own free-text order/receipt
  id, unique per vendor via a **partial-unique `(vendorId, orderId)` index where
  `orderId IS NOT NULL`** — one order is one Purchase, which is why there is no
  `splitPurchase`. An order id is optional, for example for a contractor progress payment or
  farmers-market receipt.
  - `purchase.date` is the **vendor order/receipt** date; `expense.date` stays the **ledger**
    date that drives monthly buckets and project windows. An invoice dated the
    3rd can clear on the 8th, and they may differ.
  - `statedTotal` is what the paperwork _claimed_, in dollars. It is **never
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
    other_adjustment | unclassified`. Every kind participates in total, monthly, project,
    Purchase-reconciliation, and vendor spend. Cost-type and trade analytics
    read the joint allocation, so an adjustment's money follows the trade and
    cost type of the principals it was charged on (see
    [spending classification](../spending-classification.md)). Tool and affinity
    analytics use only `principal`.
  - An unclassified amount remains visible as unresolved money. It is neither
    a principal nor an adjustment, cannot identify a Product, and does not
    inherit a Project or spending category. Resolving its receipt role does
    not change its amount.
  - Non-principal rows cannot link `productId` or `productQuantity`. A trade
    typed onto one claims the whole adjustment at its own `costType`;
    otherwise its stored `costType` applies only to shares with no principal.
  - `productQuantity` is **signed**, and may be **fractional** — the unit is the
    shelf's unit, so half a conduit coil binned is `-0.5`. Money direction wins,
    and the quantity's own sign is consulted only when there is no money:

    | `cost`           | reads as                                              | example                                                         |
    | ---------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
    | `> 0`            | acquisition of `+\|qty\|`                             | bought 8 outlet boxes                                           |
    | `< 0`            | exit of `−\|qty\|`                                    | returned 8, sold one tool                                       |
    | `= 0`, `qty > 0` | free acquisition                                      | promo battery, bundled accessory                                |
    | `= 0`, `qty < 0` | discard / write-off                                   | thrown away, given away                                         |
    | `< 0`, `qty = 0` | price concession, item KEPT                           | Amazon "Account adjustment", partial refund for shipping damage |
    | `NULL`           | unknown; contributes nothing, reported as uncertainty | old receipt with no count                                       |

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
vendor _filter_, by contrast, is now `vendorId`-based, not a free-text match.

**Operations** (`domains/purchase/repo/purchase.ts`): `linkExpensesToPurchase` (one invoice
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
  that ingredient _is_ a sub-recipe; using it in another recipe's section nests
  one recipe inside another. Costing memoizes sub-recipes (with a cycle guard).
- **MealRecipe (occurrence and preparation).** A `Meal` (a calendar day
  occasion) groups `MealRecipe` rows — each a recipe planned at a numeric
  `scale`, and optionally one physical preparation with expected and measured
  cooked yields. Repeating a Recipe or cooking it twice means two rows. No
  inventory is mutated, and planned meal totals are rolled up read-time as
  `sum(recipe.totals × scale)` (see `domains/meal/repo/helpers.ts`).
- **MealRecipePortion.** A gram amount from one source `MealRecipe`, assigned to
  one member or guest Ledger Party at a target `Meal`. It may target a later
  leftovers Meal; confirmation distinguishes projected from consumed calories.

**Totals.** `Recipe.totals` (cost/calorie rollup) is **persisted** server-side
with a `totalsComputedAt` staleness stamp; lists read the persisted value
rather than recomputing. Writes record a dirty root; the generic background
frontier finds affected recipes and their parents in bounded pages. It computes
each recipe outside the transaction and commits totals with the page's durable
acknowledgement. Queue delivery is a wake-up, not completion of cache work.
A persistent publication watermark prevents a delayed invalidation from
clearing totals already computed from the same or newer inputs. While a
relevant frontier is unfinished, reads report the totals as pending.
Meals and portions never persist totals — planned
Meals scale the Recipe's current totals, while portions project the same live
totals through their source preparation's yield.

---

## "capture" vs "import" vs "enrich"

Three verbs that all _bring data in_ but mean different things:

- **Capture** — quick, manual, first-party data entry, usually mobile. The
  canonical case is **barcode scan → quick-create a Product / InventoryEntry**.
  Capture is about _you_ recording what you physically have. (UI: "scan",
  "quick add".)
- **Import** — pulling a _recipe_ in from an external source and converting it
  into Cubby's shape (`ImportRecipe → RecipeCreateInput`, then upsert). Sources
  are tagged via `Recipe.sourceType` — see below.
  Code: `import-recipe-convert.ts`, `upsertImportRecipe`, the `recipe_insights.import_from_url`
  MCP tool.
- **Enrich** — the optional **service layer** augmenting an entity with derived
  / external data _after_ it exists (the architecture's
  `Router → Service (enrichment) → Repo`). The canonical case is decorating a
  Product with USDA nutrition or running portion data through WASM. Enrichment
  never owns the row; it adds to it.

| Verb    | Direction                       | Owns the row?    | Typical trigger               |
| ------- | ------------------------------- | ---------------- | ----------------------------- |
| Capture | user → DB                       | yes (creates it) | barcode scan, quick add       |
| Import  | external source → DB            | yes (creates it) | recipe scrape / EPUB / Notion |
| Enrich  | external/derived → existing row | no (decorates)   | USDA link, WASM conversion    |

---

## Recipe source (provenance)

`Recipe.sourceType` (a text column with a generated CHECK, not a database enum)
tags where a recipe came from; the `source.ts` codec turns the recipe columns
(`sourceType`, `sourceUrl`, `sourceLabel`, `cookbookId`) and an external id into
a tagged provenance union for the API. Values:

| `sourceType` | Meaning                        | Where the source lives                                |
| ------------ | ------------------------------ | ----------------------------------------------------- |
| `Website`    | Scraped/imported from a URL    | `sourceUrl`                                           |
| `Book`       | Extracted from a cookbook EPUB | `cookbookId` (FK → `Cookbook`); `sourceLabel` if none |
| `Notion`     | Synced from a Notion page      | an `EntityExternalId` (`source` notion, `kind` page)  |
| `Other`      | No identifiable source         | nothing                                               |

A `Book` recipe's title is its Cookbook's name, so the recipe stores no copy of
it; `sourceLabel` holds the title only for a book with no Cookbook row.

---

## Cookbook (the source) vs cookbook (the physical book)

- **`Cookbook` (entity)** — a digital recipe _source_: the EPUB-extracted set,
  its assembled `ImportRecipe[]` JSON (so recipes can be re-derived without
  re-running the LLM), OPF metadata, and a cover image. `Book` recipes FK to it.
- The **physical book on a shelf** would be a `Product` / `InventoryEntry`, and
  can be linked through `Cookbook.productId` after human confirmation.
  The digital source and physical possession remain separate records; a title
  match never links them automatically.

---

## Domain language

Each term names one concept; the _Avoid_ line lists names that blur it.

**AI standard cost**:
The equivalent published API price for AI work before plan coverage or billing discounts, respecting published rates for its token classes, including prompt caching. A comparison may be unavailable when no equivalent price can be established.
_Avoid_: charged cost, household expense, uncached price

**AI charged cost**:
The incremental amount attributable to AI work after plan coverage, response caching, or billing discounts; it may be estimated or provider-reported, with that distinction retained. A plan-covered call has zero incremental charge; the plan's subscription fee is separate.
_Avoid_: standard cost, subscription fee, confirmed bill when only estimated

**Image job**:
One durable unit of image processing (subject lift, description, or identification) for one Image source and processor revision, identified by `IPR-`. AI Gateway or an Apple device claims it in attempts, each with its own diagnostics and events; a Run that requested it may already include its cost.
_Avoid_: image processing run, activity row

**Run**:
A durable record of coordinated work, identified by `RUN-`, with a purpose, trigger, status, and optional targets or operations. It may group image jobs, but its recorded cost can already include their costs. The Runs list presents every purpose together. Retained target outcomes, including Email targets, remain visible after the mutable target roster is retired. A vendor mail search is a Run: what was asked and where its page-by-page walk stands belong to the Run itself.
_Avoid_: image processing job, individual attempt, search job

**Run kind**:
A Run purpose declared once in `RUN_KINDS`: its label, trigger, whether it is
routine or historical, how it executes, and its ordered steps. Routine kinds
(connection discovery; historical derived refresh passes) are hidden from the Runs list by
default and create their Run only when a pass has work.
_Avoid_: workflow purpose, step-run purpose

**Run step**:
One declared stage of a Run, with an input mode. A `count` step freezes its
population with one COUNT when it starts and reads "done of N"; inputs that
leave before the pager reaches them end as `removed`. An `estimate` step reads
"about N" and a `tally` step only its running counts, so neither shows a
percentage or ETA. A step that has not started reads "Not started".
_Avoid_: phase (a progress sample), child Run

**Job**:
The durable unit of execution: one keyed Postgres row with a lease, cursor,
attempts and generation. A `run.execute` Job pages a Run; an `ai.evaluation`
Job executes one AI evaluation that a Run owns or requested.
_Avoid_: task, workflow instance

**Queue**:
Transport that wakes the Job drain. A delivered or lost message never
completes or loses work; the Job rows hold it.
_Avoid_: Job, backlog

**Image processing job**:
One image operation, identified by `IPR-`, with its own kind, state, attempts, and diagnostics. The stored `ready` state means successfully completed work; clients display it as Completed. A skipped operation retains its reason and does not imply successful processing. It may belong to a Run or stand alone. Its cost is a component of a parent Run total when both are shown, not an additional household expense.
_Avoid_: Run, merged work record

**Image observation**:
A machine-produced claim about what is visible in an image, retained as evidence rather than a confirmed fact about the depicted record. It can inform search and suggestions without establishing identity, ownership, or current stock.
_Avoid_: confirmed identity, inventory change

**Identification candidate**:
An existing record proposed as a match for something depicted in a photo. Its rank or score supports review; it does not itself confirm the match.
_Avoid_: confirmed match, duplicate

**Photo group**:
A reviewed set of item and label photos intended to describe one physical item
or an explicitly counted set of identical copies. Combining photo groups does
not establish that two catalog Products are duplicates.
_Avoid_: Product merge, additional owned copy

**Photo attachment**:
An association between an Image and the Product it depicts or documents.
Attaching a photo alone establishes neither a new owned copy nor a change to
the Product's identity fields.
_Avoid_: Product merge, inventory receipt

Plant, Planting and Garden Entry are defined under [Garden](#garden).

**Growing guide**:
Checked-in, source-specific planting windows associated with a Plant through its crop key. A guide preserves each source's microclimate and planting method. Household practice (how a crop is started, how often it is resown, crop-level days to maturity marked cited or estimate) is separate checked-in data under the same keys and never reads as a citation.
_Avoid_: seasonal plan, consensus recommendation

**Book Product**:
A physical book cataloged as a Product. Its ISBN is the book's GTIN identifier, editions or formats with distinct ISBNs are distinct Products, and a printed cookbook belongs here when recorded as a possession.
_Avoid_: Cookbook, EPUB, ebook

**Product movement**:
A dated acquisition, exit, discard, or uncertain change involving a Product, derived from a product-linked Expense or explicit Purchase provenance.
_Avoid_: Product purchase, sale event

**Unlocated product**:
A Product whose movements net to one or more units owned, with no live inventory entry placing it anywhere. Says where the record is silent, not that the thing is lost — a consumable that was used up reads the same way, because inventory never auto-decrements.
_Avoid_: lost product, missing inventory, shrinkage

**Stock tracking**:
Whether a Product belongs on a shelf as Inventory. A Product's own decision wins; when it has none, it inherits the nearest Product Category's. Only an explicit or inherited not-tracked decision keeps an arriving order from asking to be received; tracked and undecided Products, and lines with no Product yet, still ask. The "Not on a shelf" triage holds only undecided Unlocated products; a tracked Product with nothing on a shelf is not in that view, and no saved view lists it.
_Avoid_: inventoried, shelved, stocked item

**Consumable**:
A Product that is used up and bought again, as opposed to a durable one that is kept. It describes the Product and never decides Stock tracking: saw blades are consumable and tracked, groceries are consumable and untracked.
_Avoid_: supplies, disposable

**Backstock**:
Inventory a member deliberately keeps of a Product that is not stock-tracked, such as a spare in the garage cabinet. It is recorded by hand where it sits; arriving orders never create it.
_Avoid_: stash, reserve, pantry inventory

**Ledger Party**:
An economic participant in household contribution accounting, and the identity behind Device ownership and Image Sighting reports. Its kind is exactly member, guest, or household. A null attribution is unknown; unknown is not a party.
_Avoid_: payer, account owner, beneficiary

**Owner**:
The member or guest who owns an Inventory entry. An owner set on the entry wins (Set here); Household is the entry set to no individual owner; otherwise the entry inherits one from acquisition evidence (the Expense beneficiary, then the vendor account default, then the payment account default), and Confirm pins that inherited owner as Set here. An entry that inherits nothing reads Unknown. A Product's Owner is a read-only rollup of its live entries' effective owners (people, Household, Unknown); a Product with no entries shows the owner its single purchase would supply, and is otherwise blank.
Entirely unattributed Expense beneficiaries (no rows or only null-party rows, including allocations preserved by itemization) supply no ownership decision, so account defaults may apply. A named Household Party, split beneficiaries, conflicting beneficiaries, or known attribution on only part of an acquisition blocks weaker defaults. Financial attribution and its totals remain unchanged by ownership inheritance.
_Avoid_: belongs to, assigned to, buyer

**Inherited**:
A value a record takes from another record rather than storing itself (a parent task, a category ancestor, purchase evidence). Every client marks it with the same tree icon until someone sets or confirms a value; the three states read Inherited, Set here, and None. "Use inherited" returns a set value to inheriting ("Clear value" when there is nothing to inherit, so the reset only empties it) and "Set to none" (or the field's declared None label, such as "Set to Household") records an explicit None; a client offers only the actions that would change the field.
_Avoid_: derived, computed, default; "Use no value"

**My stuff**:
The Inventory entries whose Owner is the viewing member. Wardrobe narrows My stuff to the apparel category family. Books (`books` family) and Records (`music` family) include both the viewing member (`@me`) and explicitly shared stock (`@household`); another member's stuff is My stuff with that member as Owner.
_Avoid_: my products, belongings

**Device**:
One registered native app instance on a phone or Mac, identified independently of a session or push token; a reinstall can retain the same identity. Optionally owned by a Ledger Party member and linked to the physical phone or Mac as a Product. An automatic-work switch, set on the device itself, and a remote-pause override, set from the web, together decide whether the job dispatcher sends it companion work; either one is enough to make it a plain viewer.
_Avoid_: session, connection, install id

**Entity Link**:
A named pairing of two entities with no meaning beyond the pairing: a wish's candidate Product, the Products a purchase bought, a kit's component with a count, a task blocked by another. Removing a link removes neither entity, and a link is never a place to keep money.
_Avoid_: join row, edge table

**External Identifier**:
A name an outside system gave an entity — a retailer's product number, a barcode, a Notion page, a card statement's order reference — recorded with the source it came from. One identifier from one source names at most one live entity.
_Avoid_: source ref, foreign id

**Image Sighting**:
One party's report that a stored Image exists in their photo library or cloud asset store, made by one reporting Device. A sighting has no identity outside its Image. A repeat report for the same image, owner, and asset key replaces the sighting's observation columns rather than duplicating it. Several sightings on one Image are ordinary: Photo Library sync can put the same asset on a member's phone and Mac, and a photo shared between members can be reported by more than one Ledger Party.
_Avoid_: upload record, device attachment, image copy

**Capture Attribution**:
How confidently an Image's derived capturer, timestamp, and location reflect reality. `none` is the default with nothing derived; `derived` means one Ledger Party's Image Sightings (or, failing that, embedded EXIF) settled it; `ambiguous` means several parties scored equally and no sighting decides it; `confirmed` means a member set it by hand, and a confirmed value is never recomputed.
_Avoid_: provenance, source, upload metadata

**Household Party**:
The intentional shared participant used when spending or consumption belongs to the household collectively. It is not a synthetic person and does not imply a debt.
_Avoid_: default person, pooled user

**Expense Attribution**:
A statement of who consumed an Expense and which party initially funded it. Attribution describes allocation of existing cost; it does not create money.
_Avoid_: reimbursement, ownership percentage

**Ledger Transfer**:
A project-neutral movement between Ledger Parties. A transfer is distinct from the statement records that may evidence it.
_Avoid_: Expense, contribution line, duplicate bank movement

**Internal move**:
A Ledger Transfer whose sending and receiving party are the same, such as one person moving money between two of their own accounts. It is recorded for completeness and reported apart from transfers sent and received.
_Avoid_: internal transfer, self-transfer, account transfer

**Irregular category**:
A root Spending Category with spend in fewer than 3 of the trailing 12 complete months. The cash-flow baseline groups these into one row by default; like every category, each carries its mean (trailing total ÷ 12).
_Avoid_: one-off, rare spend, outlier

**Source Claim**:
An assertion that an external source supports an Expense or transfer fact, including the source amount and any explicit decision about a discrepancy.
_Avoid_: imported truth, automatic match

**Itemization**:
A Purchase recorded as the order's own item lines, each goods line naming its Product, rather than one lump amount or a slice of an un-itemized total. Goods paid in instalments are itemized by linking their Products to the Purchase, since an instalment line carries no Product. It describes the line shape, not whether the lines were checked against a document.
_Avoid_: reviewed lines, receipt itemization

**Itemization expectation**:
Whether the household expects a Purchase to be itemized: required for online orders with retrievable history, not expected for in-store shops, restaurants, groceries and one-amount services. It resolves from the transaction or Purchase, then the Vendor, then the Spending category, and an attached receipt or invoice makes it expected. No policy requires a document.
_Avoid_: receipt expectation, evidence expectation, receipt policy

**Lump**:
A Purchase or charge booked as an amount without its item lines.
_Avoid_: aggregate order, unitemized receipt

**Contribution position**:
A party's cumulative outlay and transfer movement less attributed consumption. It is a reconciliation position, not an automatic claim that someone owes money.
_Avoid_: debt, settlement balance

**Attribution gap**:
An Expense role or Ledger Transfer the contribution reports cannot state from recorded or derived evidence. An assumed-household beneficiary and a not-yet-paid funder are reported with the gaps but are fallbacks, not missing data.
_Avoid_: attribution error, unattributed expense

**Credit**:
A negative Expense that changes actual cost, such as a vendor refund or a non-member's repayment of a cost the household fronted, such as a friend's share of a group trip. A repayment between members is a Ledger Transfer.
_Avoid_: contribution

**Meal preparation**:
One physical cooking of one Recipe occurrence planned into a Meal. A Meal Recipe occurrence has at most one preparation.
_Avoid_: inventory batch, recipe version

**Meal portion**:
An entered quantity and unit assigned to one Meal eater from a source Meal preparation at a target Meal. Nutrition is derived from the current preparation and Recipe. Future portions are planned; today and past portions are logged according to the household date.
_Avoid_: serving, inventory decrement

**Meal eater**:
A member or guest Ledger Party named on a Meal portion or Meal food entry. The Household Party is not a Meal eater.
_Avoid_: household, unknown person

**Meal food entry**:
A quantity and unit of an Ingredient or Product, or named manual nutrient totals,
assigned to one eater at a Meal. Source conversions and nutrition remain live;
the entered amount is retained even when its nutrition cannot yet be calculated.

**Classification**:
A value from a fixed or household-edited vocabulary that sorts a record, such
as a Product Category's feature or a Spending Category.
_Avoid_: tag (Tags are free-form labels, not classifications)

**Classification policy**:
What a classification value implies about another field on the classified
record: the field is required, not expected, unknown, or not allowed.
_Avoid_: field rule, expectation (when meaning the whole policy)

**Assessment**:
A computed judgment about a record, field or relationship, based on specified
evidence. It may support a Suggestion or a Problem; it is not a confirmed
household fact.

**Connection candidate**:
A proposed, specifically named relationship between existing records, with
evidence and an explicit effect of acceptance. It is a Suggestion backed by an
Assessment, not a generic similarity link. [Connection discovery](entity-connections.md) owns
discovery and review behavior.

**Acquisition candidate**:
A Connection candidate proposing that a particular Purchase or Expense
acquired a Product. Repeat purchases of the same exact variant are separate
acquisition events; item cost and quantity can remain unknown.

**Feedback**:
The household's review of an Assessment, including its verdict and any
corrected value, reason or supporting evidence. Feedback supplies evidence for
improving detection and evaluating future judgments.

**Dismissal**:
A preference to stop presenting a candidate, without asserting whether the
underlying judgment is correct. Confirming distinct Products is Feedback,
not a Dismissal.

**Identity conflict**:
Evidence that assigns incompatible identities to the same supposed variant,
such as a shared exact identifier with conflicting verified sizes or colors.
The contradictory facts need resolving before deciding whether records are
duplicates.

**Suggestion**:
A classification, field value or record change that has been computed but not
yet accepted by the household. It changes data only when accepted, or when an
explicit Automatic rule authorizes its application.
_Avoid_: proposal, Jev suggestion, recommendation

**Automatic decision**:
A classification or change already acted on without waiting for household
review. The household can review it afterwards and mark it Wrong.

**Transaction suggestion**:
A Suggestion, computed from one statement charge, to create a
Financial Transaction, attach the charge to an existing one, supersede a
recorded hold with its posted row, or void a hold a later export no longer
contains, or book spending on an already matched transaction. It uses the
`statement_transaction` Assessment family and the shared review path. Posted
spending also books or links Expenses; a transaction alone adds no spend.
Import-clean booking and uncertainty follow
[evidence convergence](../import-evidence-convergence.md). A clean one is
bulk-acceptable: a create is clean only when at least two of the category
rule, the decision label and merchant history agree on its kind, none
disagrees, and the counterparty is not a person.
_Avoid_: statement proposal, auto-match

**Transfer pair suggestion**:
A Suggestion, with the `transfer_pair` Assessment family, that two opposite
money movements on different accounts are one Ledger Transfer or Internal move.
Accepting it creates any missing leg and pairs both; dismissing it suppresses
that pair. Clean, cash-leg and overlap policy lives in
[ADR 0016](../adr/0016-shared-assessments-and-feedback.md#transfer-pair-suggestions-2026-10-19).
_Avoid_: transfer match, auto-pair

**Decision model**:
The closed-set classifier behind every Suggestion and Mail triage: Jev or
Clef, chosen by the trial split (unpinned field decisions hash their input, so a
repeated question reuses one model). Stored stages and user-facing text
say "decision"; the record's `model` names which one answered.
_Avoid_: Jev (when either model may have answered)

**Correction**:
A Suggestion whose value differs from the record's current value.

**Addition**:
A Suggestion for a field that is currently blank.

**Miss**:
An Assessment the household reports as wrong. A corrected value or verdict and
its evidence distinguish a confirmed Miss from uncertainty or a preference to
hide a candidate. A Miss is evidence for improving rules, prompts or
classification choices, not a standing instruction to hide the result.
_Avoid_: dismissal (a presentation preference, not a correctness verdict)

**Sweep**:
A bulk pass that computes Suggestions across a filtered set of records. A
member's "Find suggestions" starts one Sweep across every Suggestion family in
scope, with one part per family; automatic passes are Sweeps too. A Sweep is
a Run kind whose families contribute Run steps; its evaluations are
`ai.evaluation` Jobs the Sweep owns or requests, not child Runs.
_Avoid_: backfill (when the work produces Suggestions rather than derived data),
discovery (outside the connection code path)

**Suggestions page**:
The one place to review pending Suggestions of every family without opening
each record, with each family's evidence beside its review actions.
_Avoid_: inbox, review queue

**Strength**:
How well a Suggestion's evidence supports it: strong, medium or weak, judged by
its family from that family's own evidence. Model confidence alone never makes a
Suggestion strong.
_Avoid_: quality (a record's completeness), score

**Impact**:
The record Quality a Suggestion would restore if accepted, from the
data-quality checks its family says acceptance resolves.

**Automatic rule**:
A named, versioned family rule that applies matching Suggestions without
review. A member turns it on only after reviewed matches show it is precise
enough. It turns itself off when audit reviews show its precision dropping.
Every change it makes stays visible as applied automatically.
_Avoid_: auto-apply threshold, confidence cutoff

**Audit sample**:
The share of an Automatic rule's matches held for review instead of applied,
so the rule's precision stays measured.

## Purchase research

**Email**:
A message Cubby scanned from a member's mailbox, including unrelated messages. Every Email retains its sender, subject and received date; its Relevance determines whether its body and attachments are retained.
_Avoid_: OrderMail, order mail, receipt email, scanned message

**Relevance**:
Whether an Email evidences an actual household acquisition, payment (including incoming marketplace seller payments), refund, subscription or order lifecycle, with the stage that decided it (rule, decision model, relevance model or a member's resolution). Confirmed service reservations and flight bookings, including forwarded confirmations, are related even without a price or order number; accompanying promotional text does not negate confirmation. Product-specific feedback requests that confirm a real purchase or return are related even without an order number or price. Carrier digests that identify a merchant and tracking number for an actual inbound parcel are related shipment evidence without order or payment details. Scanned letters, postal advertising and generic shipping promotions alone are unrelated; unreadable parcel details remain uncertain. Promotions and abandoned-cart or unfinished-checkout reminders are unrelated unless they independently confirm an actual purchase, completed payment or order lifecycle; product names, prices and checkout buttons alone are insufficient. Unreadable, incomplete or ambiguous evidence is uncertain. Only a related or uncertain Email keeps its content.
_Avoid_: triage result, classification verdict

**Mail discovery**:
Unattended paging of a member's mailbox that records every Email's Relevance, keeps related and uncertain content, and records exact coverage.
_Avoid_: mail sync, Gmail scan

**Classification-only backfill**:
A Mail discovery pass over mailbox history that decides Relevance with rules and the decision model alone and imports nothing, so Relevance can be reviewed before any Mail import.
_Avoid_: dry run, Jev-only scan

**Mail import**:
Unattended interpretation of classified Emails into Purchases, Expenses and Product resolutions.
_Avoid_: mail research, email processing

**Exact identity match**:
An existing Product that already owns one of an imported line's identifiers, or whose name or alias equals the line's name apart from letter case and surrounding spaces. A merely similar name is never an exact identity match.
_Avoid_: fuzzy match, likely duplicate

**Distinct-from decision**:
A recorded judgment that an imported line is a different Product from an exact identity match, retaining a URL and excerpt in notes that show the difference (model, size, pack or kit contents). Without one, an import may not create a Product beside its exact identity match.
_Avoid_: force new, override

**Email pipeline**:
The ordered steps an Email can pass through: retrieval, rule, decision model, relevance model, member review, extraction preview, Mail import and Purchase association. For one Email, each step has run, was skipped because an earlier step decided, has not been reached, or failed.
_Avoid_: processing trail, stage ledger, triage

**Reclassify**:
Rerunning an Email's Relevance stages from its original, retrieving it again when its content was not retained. The new result is history; it replaces the Email's Relevance only when that keeps retained content, and never overrides a member's resolution.
_Avoid_: rerun triage, retriage

**Vendor alias**:
Another name a Vendor trades under, recorded by a member, a Vendor merge, or Sender proof, so import finds the existing Vendor by that name.
_Avoid_: vendor nickname, similar vendor

**Vendor Account**:
A member's purchasing relationship with one Vendor, including guest checkout and in-store purchases. It groups that member's Purchases independently of who paid or which login supplied evidence.
_Avoid_: vendor login, payment account

**Sender proof**:
An order Email arriving from a sender address already recorded on a Vendor, which proves that Vendor regardless of the merchant name the Email shows. A sender at the registrable website domain of exactly one Vendor also proves it; a shared mail, storefront, payment or relay domain never does.
_Avoid_: domain match

**Research queue**:
The derived, unstored list of household records whose quality further research could improve.
_Avoid_: worklist, enrichment queue, backlog

**Work queue**:
The derived, unstored list of everything waiting to be done — research, review, repair, Problems and waiting work — across records, Emails, findings, Suggestions and Runs, composed from Work sources. It shows the same rows wherever a record appears; it assigns nothing. Problems is its saved view of the `problem` Work family.
_Avoid_: inbox, task list, assignments

**Work source**:
One domain's contribution to the Work queue: the reasons it can raise, its Work family and Executor, where its rows link, the actions they offer, and a query for its candidate rows. Domains declare Work sources; the queue composes them and owns filtering, search, sorting, Group by, saved views, counts and paging.
_Avoid_: work kind, routing rule, lane

**Work family**:
The kind of work a Work source contributes: research, email, reconciliation, execution, account, finding, problem or suggestion.
_Avoid_: source (for the family), kind

**Executor**:
Who acts on a Work queue row: Cubby automatically, an agent session, a household member, or something outside the household (a posting window, a paused Run). The queue's Automatic, Agent, Review and Waiting views are its values.
_Avoid_: lane, assignee

**Work owner**:
The members who can act on a Work queue row, from the authority its Work source needs. Shared work lists every member, so filtering by a member (including Me) includes it; Unresolved means no current member holds that authority. It follows the source, never inventory ownership.
_Avoid_: waiting for, assignee, Either

**Declared list**:
A list surface whose filters, sorts, Group by choices and saved views are declared once, with its URL codec, filter options, server predicates and input schema derived from that declaration. Entity lists, the Work queue and each Suggestion family are declared lists.
_Avoid_: hand-wired filters, view filters

**Relation list**:
A Declared list over a SQL relation rather than one entity table, such as the Work queue's union of Work sources or a Suggestion family's rows. It shares the entity lists' filter codec and predicate compiler.
_Avoid_: source list, virtual list

**Burn-down**:
A member's Claude or Codex session working through the Research queue with ordinary writes that retain research in notes.
_Avoid_: enrichment run, sweep

**Research notes**:
Ordinary editable notes retaining useful links, record shortcodes, excerpts and observation or variant context. Notes do not certify a current field value; inherited values remain dynamic.
_Avoid_: citation status, verified field
