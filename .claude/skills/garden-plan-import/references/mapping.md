# Field-by-field mapping

## Location

| Plan concept                                 | Field                 | Notes                                                                                                                                                                                                                                                      |
| -------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bed name ("Bed 3", "the north bed")          | `name`, `type: "bed"` | Search before creating — beds are usually already in Cubby from a prior season. Set `type` even when the Location links a Product (a bought raised bed) — the Product supplies identity and price, `type` states the form factor; the two are independent. |
| Pot / container                              | `type: "planter"`     |                                                                                                                                                                                                                                                            |
| Open ground / yard / tree perimeter          | `type: "area"`        |                                                                                                                                                                                                                                                            |
| Soil condition, sun exposure, drainage notes | `notes`               | Generic textarea; this is the only garden-specific text field left on Location.                                                                                                                                                                            |
| Row/section within a bed                     | _(not modelled)_      | Put it in the Planting's `notes` or fold it into `quantity`/`plannedWindow` text ("row 2, 3 plants"). Never create a child Location for a grid position.                                                                                                   |
| Parent yard/property, if the plan has one    | `parentId`            | Only when an existing or clearly-named parent Location exists; do not invent a synthetic root.                                                                                                                                                             |

## Project (one per season)

| Plan concept                                     | Field                             |
| ------------------------------------------------ | --------------------------------- |
| Season name ("Example Beds Fall/Winter 2026–27") | `name`                            |
| —                                                | `kind: "garden"`                  |
| Season start/end, if stated                      | `startDate` / `endDate`           |
| Watering schedule prose                          | `notes`                           |
| Lessons learned / retrospective prose            | `notes` (append, don't overwrite) |
| Skip-list ("don't replant X here again")         | `notes`                           |

Everything narrative that isn't itself a calendar row, shopping line, or
planting stays in this one `notes` field. Resist decomposing prose into
records just to have somewhere to put it.

## Task (one per calendar row, one per shopping-list line)

| Plan concept                                                                      | Field              |
| --------------------------------------------------------------------------------- | ------------------ |
| The row's action ("Direct-sow fava beans", "Buy mesh drawstring bags ×20")        | `name`             |
| The season Project                                                                | `projectId`        |
| The heading date the row sits under                                               | `dueDate`          |
| A matching existing Product (checked with `resolve_products`, never created here) | `subjectProductId` |
| A trade/category the plan implies (rare)                                          | `trade`            |

Group by the plan's own headings — a "November" section becomes Tasks with
`dueDate` somewhere in November; a "Shopping list" section becomes Tasks with
no planting attached, just the purchase itself as the action.

## Planting (status always `"planned"` at import time)

| Plan concept                                       | Field                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The cultivar (or species)                          | `plantId`, resolved in batch via `resolve_plants` with its crop `gardenGuideKey`                               |
| The bed/pot it goes in                             | `locationId` — leave `null` if the plan hasn't assigned a bed yet                                              |
| Count or weight ("×3", "¾ lb")                     | `quantity` (text, as stated — never parsed into a number)                                                      |
| Stated timing ("plant now", "Nov", "early spring") | `plannedWindow` (text, as stated)                                                                              |
| The Task that will do the sowing/transplanting     | `taskId`                                                                                                       |
| Seed source, if already owned as a Product         | `sourceProductId` — only when a Product already exists; otherwise leave null until purchase-import creates one |

`sowedOn`, `transplantedOn`, and `finishedOn` stay unset — those record what
actually happened, which this skill never claims on the plan's behalf. When
the household later sows or transplants, a nursery-bought seedling normally
gets `transplantedOn` alone, with no `sowedOn` — that's the ordinary shape
for bought stock, not a special case; the planting timeline infers the
interval's start from `transplantedOn` when `sowedOn` is null. A planned
Planting also never carries photos (planting has no photo gallery) — photos
belong on the GardenEntry the household logs later.

## Plant

| Plan concept                                                          | Field                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Cultivar as sold ("Sun Gold F1", "Windsor"), or the species when none | `name`                                                                                                                   |
| The crop                                                              | `gardenGuideKey` — an existing key in `gardenCropKeys` (`packages/schemas/src/garden-practice.ts`); never invented       |
| Undecided between cultivars ("DiCicco or Belstar")                    | Resolve the top pick; name the alternate in `Plant.notes`                                                                |
| Grow / maybe / skip lists, "never X here"                             | `verdict: yes \| maybe \| no`; the reason in `notes`. A crop-level "never" is a species Plant ("Okra") with verdict `no` |
| Days to maturity from a cited packet or listing                       | `daysFromSowMin/Max` or `daysFromTransplantMin/Max`, URL in `notes`; crop estimates stay in `garden-practice.ts`         |
| The cooking ingredient the harvest becomes                            | `ingredientId` (informational only; pass `ingredientName` to `resolve_plants`)                                           |

The Plant's `routes` read out how and when each practice start route
applies this month, and a Planting's `expectedHarvest` is computed from its
sow or transplant date — neither is written by this skill.

## Seed packets and Products

A shopping-list line for seeds is a Task, not a Product — Cubby only creates
a Product once something is actually bought (the `purchase-import` skill's
job). When the household later buys a plan's seed packets, hand the receipt
to `purchase-import`, set the resulting Product's `growsPlantId`, and set its
shortcode as the matching Planting's `sourceProductId` with `entity update
planting`. Vendor URLs and prices for unbought lines stay in the shopping
Task's notes.
