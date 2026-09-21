# Garden plants, verdicts and outcomes

Status: **proposed**. Design agreed 2026-09-21 after a gap analysis of the
current garden model against a full season plan that today lives outside
Cubby, and an adversarial review against the codebase. ADR 0004 records the
grain decision; this plan carries the model, static data, tools, migration
and sequence. Nothing here is implemented yet.

## 1. Summary

The garden model — `Location` (bed/planter) ← `Planting` → `Ingredient`
(+ `gardenGuideKey`), `GardenEntry`, a season `Project` with `Task`s, and the
curated sow/transplant windows in `garden-guides.ts` — records where things
were planted and when. It has no home for what a real season plan is mostly
made of: **which cultivar and why**, **crop and cultivar verdicts** (grow it,
maybe, never here), **what happened**, **how a crop is started** (direct,
tray, indoor, or bought as a transplant) and how often it is resown, and
**where to buy it**. The consequence today is that the household's plan is a
web page and Cubby is a partial ledger of it.

This plan adds one entity and moves two fields.

```text
Ingredient (recipe grain)       "cherry tomato", "jalapeño", null for flowers
    ▲ ingredientId (nullable)
Plant (cultivar grain, PLANT-)  "Sun Gold F1", "Lady Han", "Windsor fava"
    │  gardenGuideKey · verdict · latinName · breeding
    ├──< Planting.plantId        status · dates · outcome · locationId
    └──< Product.growsPlantId    seed packets AND live plants, bought or not
                                 (vendor externalIds, price)
GardenEntry >── Location         unchanged
garden-guides.ts                 source windows, unchanged
garden-practice.ts (new)         starts[] · successionWeeks, keyed by guide key
```

Goals: a Planting names a cultivar, not free text; a cultivar carries its
verdict and its growing-guide key; a season's outcome is queryable; the
question "can I start X today, and how" is answered from static data; the
current season plan can be imported and then regenerated from Cubby.

Non-goals: bed grid positions or footprints; irrigation zones or timer
schedules; seed viability or packed-for dates; harvest aggregation; maturity
or harvest forecasts; importing a vendor catalogue wholesale.

## 2. Why

The gap analysis compared the season plan (three 4×8 beds in San Francisco,
~70 cultivars, a month-by-month calendar, a per-plant order table with
variety reasoning and not-suggested lists, controller schedules) with the
model in [docs/garden.md](../garden.md) and the live data (61 plantings, 44
garden entries, five garden projects). Findings, condensed:

1. **Variety is free text.** `Planting.variety` holds "DiCicco or Belstar",
   "Windsor" and "windsor", "Unknown (possibly Jimmy Nardello)". Nothing
   accumulates on a cultivar across seasons.
2. **Ingredient is doing two jobs.** It is the recipe grain (a recipe wants
   jalapeño) and, because `gardenGuideKey` and the plantings relation hang
   off it, also the sown grain. The live data shows the strain: one generic
   pepper ingredient holds Jimmy Nardello, Bhut Jolokia, Gochujang King and
   Shishito as varieties, while shishito, serrano, jalapeño, habanero and
   Fresno are each their own ingredient; "Sungold" exists as an ingredient
   beside the tomato ingredient that also holds a Sun Gold variety.
3. **Verdicts have no home.** "Never okra here", "Long Island Improved is the
   loose, aphid-prone strain — buy Silvia" and "cucamelon: cut, not worth the
   square" are the decisions a season plan is made of. Today they are prose
   in `Project.notes` or nowhere.
4. **Outcomes are narrative.** 24 of the 61 plantings are a January tray
   batch that never transplanted; that fact is in `notes` on each row and
   cannot be asked for.
5. **Guide coverage.** 9 of 61 plantings have a guide window. `gardenGuideKey`
   has 41 keys; the plan's crops include ~15 with none (asian greens, broccoli
   raab, cilantro, dill, parsley, sorrel, shiso, tomatillo, epazote, fenugreek,
   scallion, yardlong bean, saffron, celery-leaf, the working flowers). The
   household microclimate is a constant in
   `apps/web/src/server/garden-guides/windows.ts`.
6. **Start method and succession.** The sources' windows say *when* to sow
   or transplant; nothing says whether a crop is started direct, in an
   outdoor tray, indoors on a heat mat, or bought — the question the household
   asks most — nor that a rotation strip is resown every four weeks.
7. **Where to buy.** The plan's order table (top pick, alternates, vendor,
   URL, price) has no representation; the `garden-plan-import` skill forbids
   creating a Product before purchase.

## 3. Decision log

| # | Decision | Choice |
|---|---|---|
| 1 | Grain of the new entity | **Cultivar.** One `Plant` per named cultivar ("Sun Gold F1"); species-level rows allowed with `variety: null` (fenugreek, borage). No third crop-as-grown level. |
| 2 | Ingredient's role | **Recipe grain only.** A Plant links an Ingredient when the harvest is a cooking ingredient; flowers (alyssum, marigold) have `ingredientId: null`. Ingredient granularity follows what recipes call for, which dissolves finding 2. |
| 3 | Entity or static file | **Entity** (`PLANT-`). Rule: reference data no household changes (planting windows, start methods, microclimate calendar) is static and checked in; anything that points at household records or changes with experience (cultivars grown, verdicts, outcomes) is an entity. Entities may reference static slugs; static files never contain shortcodes. |
| 4 | Where the guide key lives | **Plant** (the sown thing), defaulting from the linked Ingredient's key at migration. Ingredient loses `gardenGuideKey` and the two window projections. |
| 5 | Verdicts | `verdict: yes \| maybe \| no` + `verdictReason` + `verdictOn` on **both** Plant (cultivar: "avoid Long Island Improved") and Ingredient (crop: "no okra"). Free-text reason; no reason-kind enum. |
| 6 | Outcome | On Planting: optional `outcome: succeeded \| failed` + `outcomeReason`. `status: finished` never requires one. "Partial" and "abandoned" are `failed` with a reason. |
| 7 | Planting loses stored fields | `variety` removed (it is the Plant's); stored `ingredientId` removed, kept as a **read-only projection** through the Plant so crop filters and the Ingredient detail's Plantings section keep working. |
| 8 | Products | `growsIngredientId` → `growsPlantId`. Seed packets **and live plants** are Products pointing at a Plant and may be created from vendor listings (top pick + alternates, vendor `externalIds` + price) **before purchase**. This reverses the import skill's "Products only once bought" rule. No tags, no form field — the product name says Seeds or Live Plant. |
| 9 | Vendor listings | Are those Products. No listing table, no `sources` on Plant; prices and stock go stale in weeks and the decision-grade fact is the URL. The offline vendor scrape proposes Products; it is not imported wholesale. |
| 10 | Source windows | `garden-guides.ts` **stays source-only** (its header promises byte-identical source data; `garden-guide.ts` enforces `windows.min(1)`; the unit test pins the UC key set). |
| 11 | Household practice | New static `garden-practice.ts`: per guide key, `starts: ("direct" \| "tray" \| "indoor" \| "bought")[]` and `successionWeeks: number \| null`. Its key set is a superset of the source guides; crops with no citable window exist here with practice only. Vocabulary is deliberately distinct from the source `method` enum so a household claim never reads as a citation. |
| 12 | Route viability | A projection on Plant: seed-based starts evaluate against the source's *seed* windows, `bought` against *transplant* windows; a crop with two routes declares two starts and each is read independently, with both readings reported ("sow now indoors; plant out May–Jun"). |
| 13 | Household config | `apps/web/src/server/household/` replaces the hardcoded microclimate constant. Holds the microclimate, not the household name and never a shortcode. |
| 14 | Bed layout | **Not modelled.** Grid positions, footprints and capacity were an artefact of the web page, not something worth tracking in the real world. |
| 15 | Irrigation | **No field.** Beds and controller zones share names; the schedule is `Project.notes`. |
| 16 | Seed viability | **Not modelled.** Inventory in the seed drawer is assumed viable. |
| 17 | Harvest aggregation | Not now; `GardenEntry.harvestAmount` stays text. |
| 18 | Plant merge | `merge: true`, Ingredient merge as the template (hard-delete + repoint). The variety-text migration will mint duplicates and the MCP checklist needs a cleanup verb. |
| 19 | Resolver | New MCP `resolve_plants` taking `{ name, ingredientName?, variety? }[]`, not bare names — "Windsor" needs its crop to resolve or create. |
| 20 | Operating prose | Controller schedules, the seed-starting fix, vendor ranking, pot assignments go in the season `Project.notes` at import, as the existing skill already says. No runbook: `docs/runbooks/` is schema rollouts. |

## 4. Domain model changes

Migrations follow [docs/agents/domain-rules.md](../agents/domain-rules.md):
expand → backfill → deploy → cleanup, and remove a `schema.ts` column
declaration and deploy before any `DROP COLUMN`.

### 4.1 `Plant` (entity, `PLANT-`)

`PLANT-` satisfies the generator's `^[A-Z]{2,5}-$` prefix rule (precedent
`VACCT-`). Its adjacency to `PLT-` (Planting) is accepted: the two are
neighbours in meaning too.

| Column | Type | Notes |
|---|---|---|
| `name` | text, required | The cultivar as sold ("Sun Gold F1", "Lady Han"), or the species when there is no cultivar ("Fenugreek"). |
| `ingredientId` | FK → Ingredient, nullable | Null for non-food plants. |
| `variety` | text, nullable | Null for species-level rows. |
| `latinName` | text, nullable | Settles moschata-vs-maxima permanently. |
| `breeding` | enum `open-pollinated \| hybrid`, nullable | "Rebuy F1 every year" lives here. |
| `gardenGuideKey` | enum (union of source guide keys and practice keys), nullable | Moved from Ingredient. |
| `verdict` | enum `yes \| maybe \| no`, nullable | |
| `verdictReason` | text, nullable | |
| `verdictOn` | date, nullable | |
| `notes` | text, nullable | |

Projections: `displayName` (non-null; `"<name> · <ingredient name>"`, or
`name` alone without an ingredient) so Cmd-K and `/search` index it;
`guideSowWindow`, `guideTransplantWindow` (moved from Ingredient); `routes`
(§5.3). Detail sections: Plantings (history, by `plantId`), Products (seed
packets and live plants, by `growsPlantId`), the verdict trio. List views:
table. Capabilities: auditable, countable, soft delete, `merge: true`,
`bulkUpdate: ["verdict", "verdictOn", "gardenGuideKey"]`, MCP
`get/list/create/update/delete/bulkUpdate/merge`, no image storage
(`displaySources`: the linked Products' covers, then the newest journal photo
of any planting). Lifecycle: delete blocked by live Plantings or Products;
merge repoints both.

### 4.2 `Ingredient`

| Change | Notes |
|---|---|
| add `verdict`, `verdictReason`, `verdictOn` | Same shapes as Plant. Merge must carry them the way `gardenGuideKey` is carried today (`repo/ingredient/merge.ts`, `gardenGuideKeyCarried` / `Conflicts` in the public `MergeSummaryOut`). |
| remove `gardenGuideKey`, `guideSowWindow`, `guideTransplantWindow` | After backfill to Plant. Touches the manifest field/section/audit lists, `repo/ingredient/crud.ts`, `merge.ts`, `windows.ts`, the `ingredient.guide-sow-window` explanation, and the generated Swift types. |
| relation `plantings` | Becomes a two-step path: `Planting.plantId` incoming → `Plant.ingredientId` outgoing (ADR 0001 allows multi-step provenance). Section filter descriptor changes accordingly. |
| new relation `plants` | `Plant.ingredientId` incoming; a Plants section on the detail page. |
| relation `grown-by` (Products) | Becomes `Product.growsPlantId` incoming → `Plant.ingredientId` outgoing. |

### 4.3 `Planting`

| Change | Notes |
|---|---|
| add `plantId` | FK → Plant, **required** after backfill. Delete of a Plant is blocked by it; merge repoints. |
| remove `variety` | Now the Plant's. |
| remove stored `ingredientId` | Kept as read-only `ingredientId` / `ingredientName` projections through the Plant; the `ingredientId` filter keeps working via a join. |
| add `outcome` | enum `succeeded \| failed`, nullable. |
| add `outcomeReason` | text, nullable. |

Consumers that read `variety` or the stored ingredient edge, all to change in
the same expand step: the manifest's `ingredient` relation and inverse
(`db/entity-edges.ts` history edge), `repo/search-document.ts` (raw SQL
`i.name || ' · ' || pl.variety`), `semantic/text.ts`, `repo/calendar-plantings.ts`,
`plantingDisplayName` in `repo/garden/index.ts`, `intents.fields.capture`
(`ingredientId` → `plantId`; native quick-capture needs a Plant picker),
`routing.candidateFields` / `ocrFields` (`["variety", "notes"]` → `["notes"]`
unless the compiler accepts a projection there — verify), and
`validatePlantingSource` (compares `growsIngredientId` to `ingredientId`;
becomes `growsPlantId` to `plantId`, and its non-food category check means
listing Products stay category `supplies` as the existing seed records do).
`countable` and `bulkUpdate` are unaffected; `bulkUpdate` gains `outcome`.

### 4.4 `Product`

| Change | Notes |
|---|---|
| add `growsPlantId` | FK → Plant, nullable. |
| `growsIngredientId` | Derived read-only through the Plant for one release, then dropped. Public-contract touchpoints: `growsIngredientIdFilter` in `product.ts`, `repo/product/crud.ts`, `mappers.ts`, `services/product.service.ts`, the `schema.ts` FK, and the generated Swift types. |

Products created from vendor listings before purchase are ordinary catalog
rows with no movements — the same shape as an Amazon lookup nobody bought.
They must not read as unlocated, and product completeness / Problems
detectors (`repo/problems/detectors-product.ts`) must accept a priced Product
with vendor `externalIds` and no Expense; if a detector fires, add the
exception rule rather than a Product field. `purchase-import` line resolution
now legitimately matches them, which is the point.

### 4.5 Nothing else

No change to `Location`, `GardenEntry`, `Project`, `Task`, the calendar lane,
or the ICS feed. A Planting's move, journal and photo rules are as in
[docs/garden.md](../garden.md).

## 5. Static layer

### 5.1 `garden-guides.ts` — unchanged

Source windows, attribution and the hand-kept `gardenGuideKeys` tuple stay
exactly as they are. Do not relax `windows.min(1)`; do not add uncited
windows for crops the four sources omit.

### 5.2 `garden-practice.ts` — new, `packages/schemas/src`

```ts
export const gardenPractice = {
  broccoli:  { starts: ["tray", "bought"],   successionWeeks: null },
  carrot:    { starts: ["direct"],            successionWeeks: 4 },
  basil:     { starts: ["indoor", "bought"], successionWeeks: null },
  "gai-lan": { starts: ["direct"],            successionWeeks: 4 },   // no source window yet
  saffron:   { starts: ["bought"],            successionWeeks: null }, // corms
  // …
} satisfies Record<string, GardenPractice>;
```

`starts` is horticulture, not a calendar: it says where the sowing happens or
that the plant arrives as a transplant, one list per crop. A crop with two
legitimate routes lists both. Keys are a superset of the source guide keys;
`gardenGuideKey` on Plant accepts the union. New keys to add here first:
asian greens / gai lan, broccoli raab, cilantro, dill, parsley, sorrel, shiso,
tomatillo, epazote, fenugreek, scallion, yardlong bean, saffron, celery-leaf,
alyssum, nasturtium, marigold. Each gets source windows later only when a
citable source exists.

### 5.3 Route viability

`apps/web/src/server/garden-guides/windows.ts` grows a `routes(plant, today)`
projection: for each declared start, seed-based starts (`direct`, `tray`,
`indoor`) read the household-microclimate *seed* windows, `bought` reads the
*transplant* windows; the result per start is `{ start, sowNow, plantOutWindow }`
rendered on Plant as short text ("indoor: not now, sow Feb–Mar, plant out
May–Jun · bought: plant out now"). Uses existing month arrays only; infers no
dates.

### 5.4 Household config

`apps/web/src/server/household/garden.ts` exports `{ microclimate: "sunny" }`
and replaces `HOUSEHOLD_MICROCLIMATE`. Server code, not `packages/schemas`;
no household name (skill fixtures forbid real household codes in checked-in
files, and the same spirit applies here).

## 6. Tools and skills

- **`resolve_plants`** (MCP): input `{ name, ingredientName?, variety? }[]`;
  matches on `name`/`variety` within the resolved ingredient, creates when
  missing (creating the Ingredient too only when `ingredientName` is given
  and unresolved), returns `PLANT-` ids with a `created` flag. Add the hint
  line in `mcp/server.ts` beside the other resolvers.
- **`garden-plan-import`** (skill): resolve cultivars through `resolve_plants`;
  a plan row's variety becomes a Plant, not `Planting.variety`; a plan's
  "buy this" lines become Products with `growsPlantId` and vendor
  `externalIds` (top pick and alternates), and a Task per shopping line as
  today; verdicts from a plan's skip/maybe lists land on Plant/Ingredient.
  Remove the "Products only once bought" rule and its mapping/fixture text.
- **`garden-season-review`** (new skill): the end-of-season pass — list the
  season's plantings, set `outcome`/`outcomeReason`, `status: finished` and
  `finishedOn`, update Plant/Ingredient verdicts from what happened, note
  the reasoning in `Project.notes`. Exists because a field nobody is prompted
  to fill stays empty.
- Web: Plant list and detail (generic manifest rendering); Planting create
  and quick-capture pick a Plant; Ingredient detail gains a Plants section
  and loses the guide fields. Native follows the manifest.

## 7. Migration

Measured on 2026-09-21: 61 plantings (25 finished, 36 growing), ~35 seed
Products with inventory, 5 garden projects. Remeasure at execution.

1. **Expand.** Create `Plant`; add `Planting.plantId` (nullable for now),
   `Planting.outcome`, `Planting.outcomeReason`, `Product.growsPlantId`,
   `Ingredient.verdict*`, `Plant.gardenGuideKey`. Deploy.
2. **Backfill (scripted).** For each distinct (`Planting.ingredientId`,
   trimmed lower-cased `variety`) create a Plant named from the variety (or
   the ingredient when null), `gardenGuideKey` copied from the ingredient;
   set `Planting.plantId`. For each Product with `growsIngredientId`, create
   or reuse a species-level Plant for that ingredient and set
   `growsPlantId`. Report counts and the duplicate candidates the merge step
   will need.
3. **Judgment calls (MCP checklist, by hand).** Merge case-variant Plants;
   resolve the two "Unknown" bed-1 tomatoes and "roma" to Plants with
   `variety: null`; merge the stray `Sungold` ingredient into the tomato
   ingredient; mark the bed-2 rows still `growing` after the 2026-09-19
   clear-out `finished`; leave the peppers' ingredient grain alone — with
   Plant carrying the cultivar, mixed ingredient grain is a recipe-side
   question, not a garden one. Sparse pre-2026 history stays sparse.
4. **Contract.** Make `plantId` required; remove the `schema.ts` declarations
   for `Planting.variety`, `Planting.ingredientId`, `Ingredient.gardenGuideKey`,
   `Product.growsIngredientId`; deploy; drop the columns; delete the
   `ingredient.guide-*` explanations and Swift fields.

## 8. Validation

Tests to extend or add: `garden-guides.unit` (key set unchanged; practice
keys a superset), a new `garden-practice.unit` (every practice key has ≥1
start; every source key has a practice entry), `windows.unit` (routes: seed
starts read seed windows, `bought` reads transplant windows, two starts read
independently), `garden/timeline.integration` (guide band via Plant),
`search-document` (planting `displayName` through Plant), Ingredient merge
tests (verdict carry), `product/list.integration` (`growsPlantId` filter,
derived `growsIngredientId`), `entity-generator.unit` and the catalog
snapshot (new entity, removed fields), Problems detector tests (unbought
listing Products are not findings).

Acceptance for the whole plan: the current season plan is imported with the
updated skill, and its plant index, order table, verdict lists and calendar
can be regenerated from `entity list plant/planting/product/task` without
consulting the original document.

## 9. Documentation to change when code lands

Left untouched by this proposal because they are still true:

- [CONTEXT.md](../../CONTEXT.md): add **Plant** ("a cultivar or species the
  household sows or buys as a transplant; linked to an Ingredient when its
  harvest is a cooking ingredient; carries the growing-guide key and the
  household's verdict"); rewrite **Planting** ("linked to its Plant"), whose
  `_Avoid_: Crop entity` must either move or state that Plant is the sown
  grain, not a recipe crop; rewrite **Growing guide** to associate with a
  Plant.
- [docs/garden.md](../garden.md), [docs/terminology.md](../terminology.md)
  §Garden, [docs/entities.md](../entities.md).
- `.claude/skills/garden-plan-import/` SKILL.md, `references/mapping.md`,
  `references/fixtures.md` (the Products-before-purchase reversal and the
  Plant resolution step).

## 10. Open questions

- Whether the manifest compiler accepts a read-only projection in
  `routing.candidateFields`; if not, photo routing for plantings loses
  `variety` as a signal and gains nothing until Plant names are searchable
  through the relation.
- Whether `Ingredient` should keep a derived "guide via its plants" summary,
  or simply show the Plants section. Default: the section only.
- Whether `resolve_plants` should also accept a `latinName` for
  disambiguating species-level rows. Default: no; name + ingredient is
  enough for a household catalogue.

## 11. Later, enabled by this plan

Per-cultivar history across seasons ("Sun Gold: four seasons, four
successes"); a "what can I start today" page over `routes`; seed-drawer
suggestions from Products with `growsPlantId` and on-hand inventory; the
photo-comparison and season-revision work already listed in
[docs/todos.md](../todos.md) under seasonal garden planning.
