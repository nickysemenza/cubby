# Garden plants, verdicts and outcomes

Status: **shipped**; the §7 rollout, including the contract drops, is
complete in production. Design agreed
2026-09-21 after a gap analysis of the garden model against a full season
plan that lived outside Cubby; refined 2026-09-22. ADR 0004 records the grain
decision; this plan carries the model, static data, tools, migration and
rollout.

## 1. Summary

The garden model — `Location` ← `Planting` → `Ingredient` (+ `gardenGuideKey`),
`GardenEntry`, a season `Project` with `Task`s, and the curated windows in
`garden-guides.ts` — records where things were planted and when. It has no
home for **which cultivar**, **verdicts** (grow it, maybe, never here),
**what happened**, **how a crop is started** and resown, or **when to expect a
harvest**.

This plan adds one entity (`Plant`) and one static file (`garden-practice.ts`).

```text
Plant (cultivar grain, PLANT-)   "Sun Gold F1", "Windsor", "Okra"
    │  gardenGuideKey (the crop) · verdict · days-to-maturity ranges
    │  ingredientId (nullable, informational)
    ├──< Planting.plantId         status · dates · outcome · locationId
    └──< Product.growsPlantId     seed packets and live plants, once bought
garden-guides.ts                  source windows, unchanged
garden-practice.ts (new)          starts[] · successionWeeks · maturity, per guide key
```

Goals: a Planting names a cultivar, not free text; a cultivar carries its
verdict, its crop and its maturity; a season's outcome is queryable; "can I
start X today, and how" and "when will it be ready" are answered from data; the
current season plan can be imported and regenerated from Cubby.

Non-goals: bed grid positions; irrigation schedules; seed viability; harvest
aggregation; graded windows (optimal/marginal); cultivar-specific sow windows;
Products for unbought vendor listings; a harvest milestone on the timeline or
calendar (follow-up).

## 2. Why

The gap analysis compared the season plan (three 4×8 beds, ~70 cultivars, a
month-by-month calendar, an order table, not-suggested lists) with
[docs/garden.md](../garden.md) and the live data (61 plantings, 44 garden
entries, five garden projects):

1. **Variety is free text.** "DiCicco or Belstar", "Windsor" and "windsor".
   Nothing accumulates on a cultivar across seasons.
2. **Ingredient does two jobs** — recipe grain and sown grain. One pepper
   ingredient holds four cultivars while other peppers are their own
   ingredients.
3. **Verdicts have no home** ("never okra here", "cucamelon: not worth the
   square").
4. **Outcomes are narrative.** 24 plantings are a tray batch that never
   transplanted; that fact is only in `notes`.
5. **Guide coverage.** ~15 planned crops have no guide key.
6. **Start method, succession and maturity** are not recorded anywhere.

## 3. Decision log

| #   | Decision           | Choice                                                                                                                                                                                                                          |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Grain              | **Cultivar.** One `Plant` per named cultivar; species-level rows ("Okra", "Fenugreek") where there is none. `name` is the cultivar or species; no separate `variety`.                                                           |
| 2   | Crop grouping      | **`gardenGuideKey`** on Plant is the crop. `displayName` is `"<name> · <guide label>"` ("Windsor · Fava bean"), or `name` alone without a key or when it equals the label.                                                      |
| 3   | Ingredient link    | Single nullable `Plant.ingredientId`, **informational only** (harvests are not 1:1 with ingredients: thyme → fresh and dried thyme). Nothing filters or projects through it.                                                    |
| 4   | Entity vs static   | Reference data no household changes (windows, start methods, crop maturity) is static and checked in; anything that points at household records or changes with experience is an entity. Static files never contain shortcodes. |
| 5   | Verdicts           | `verdict: yes \| maybe \| no` on **Plant only**. A crop-level verdict is a species-level Plant ("Okra", `no`). Reasons go in `notes`; the audit log records when.                                                               |
| 6   | Outcome            | `Planting.outcome: succeeded \| failed`, nullable. Any harvest at all is `succeeded`. Reason in `notes`. `status: finished` never requires one.                                                                                 |
| 7   | Products           | `growsIngredientId` → `growsPlantId`. **Products only once bought** (unchanged import rule); vendor URLs live on the shopping Task.                                                                                             |
| 8   | Source windows     | `garden-guides.ts` stays source-only and unchanged; windows stay in/out and crop-level. Cultivar timing goes in `Plant.notes`.                                                                                                  |
| 9   | Household practice | New static `garden-practice.ts` (§5.2). Edited by hand when practice changes; no per-Plant override.                                                                                                                            |
| 10  | Maturity           | Ranges, from sow and from transplant. Crop-level in `garden-practice.ts` with a cited source or `"estimate"`; cultivar-level on Plant from the packet. Plant wins.                                                              |
| 11  | Harvest forecast   | Read-only `expectedHarvestStart/End` on Planting (§4.3), only from a real date.                                                                                                                                                 |
| 12  | Microclimate       | Stays the constant in `garden-guides/windows.ts`.                                                                                                                                                                               |
| 13  | Plant merge        | `merge: true`, Ingredient merge as the template (hard-delete + repoint).                                                                                                                                                        |
| 14  | Resolver           | MCP `resolve_plants` taking `{ name, gardenGuideKey?, ingredientName? }[]`.                                                                                                                                                     |
| 15  | Season review      | No new skill. `garden-plan-import` creates a "review outcomes and verdicts" Task per season.                                                                                                                                    |
| 16  | Rollout            | One PR, brief downtime accepted (§7).                                                                                                                                                                                           |

## 4. Domain model changes

### 4.1 `Plant` (entity, `PLANT-`)

`PLANT-` satisfies the generator's `^[A-Z]{2,5}-$` rule
(`scripts/generator/entities/compile.ts:967`).

| Column                          | Type                                                     | Notes                                                   |
| ------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| `name`                          | text, required                                           | Cultivar as sold ("Sun Gold F1") or species ("Okra").   |
| `gardenGuideKey`                | enum (union of source guide and practice keys), nullable | The crop. Moved from Ingredient.                        |
| `ingredientId`                  | FK → Ingredient, nullable                                | Informational.                                          |
| `latinName`                     | text, nullable                                           |                                                         |
| `breeding`                      | enum `open-pollinated \| hybrid`, nullable               |                                                         |
| `verdict`                       | enum `yes \| maybe \| no`, nullable                      |                                                         |
| `daysFromSowMin` / `Max`        | int, nullable                                            | Cultivar packet or vendor listing only; URL in `notes`. |
| `daysFromTransplantMin` / `Max` | int, nullable                                            | Same.                                                   |
| `notes`                         | text, nullable                                           | Verdict reasons, cultivar timing, sources.              |

Projections: `displayName` (decision 2); `guideSowWindow`,
`guideTransplantWindow` (moved from Ingredient); `routes` (§5.3). Detail
sections: Plantings (by `plantId`), Products (by `growsPlantId`). Capabilities:
auditable, countable, soft delete, `merge: true`,
`bulkUpdate: ["verdict", "gardenGuideKey"]`, MCP
`get/list/create/update/delete/bulkUpdate/merge`, no image storage
(`displaySources`: linked Product covers, then the newest planting journal
photo). Delete is blocked by live Plantings or Products; merge repoints both.

### 4.2 `Ingredient`

Loses `gardenGuideKey`, `guideSowWindow`, `guideTransplantWindow` (manifest
field/section/audit lists, `repo/ingredient/crud.ts`, `merge.ts` guide-key
carry, `windows.ts`, the `ingredient.guide-*` explanations, Swift types).
Loses the `plantings` and `grown-by` sections. Gains a generic Plants section
(`Plant.ingredientId` incoming).

### 4.3 `Planting`

| Change                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| add `plantId`                                                            | FK → Plant, required.                                                                                                                                                                                                                                                                                                                                                  |
| add `outcome`                                                            | enum `succeeded \| failed`, nullable; added to `bulkUpdate`.                                                                                                                                                                                                                                                                                                           |
| remove `variety`, `ingredientId`                                         | No projection kept.                                                                                                                                                                                                                                                                                                                                                    |
| add `plantName`                                                          | Read-only `text` projection through Plant; replaces `variety` in `routing.candidateFields` / `ocrFields` (the compiler accepts a derived `text` field there, `compile.ts:1930`).                                                                                                                                                                                       |
| add `expectedHarvestStart`, `expectedHarvestEnd`, `expectedHarvestBasis` | Read-only. With `transplantedOn`, add the from-transplant range; else with `sowedOn`, the from-sow range; else null. Plant values win over `garden-practice.ts`. Basis is `cultivar` (Plant, packet), `crop` (cited static) or `crop-estimate`. A bought seedling is a Planting with `transplantedOn` and no `sowedOn`. Shown on detail and as a sortable list column. |

The crop filter on Planting becomes `gardenGuideKey` through the Plant.
Consumers of `variety` / the stored ingredient edge change in the same PR:
the manifest relation and `db/entity-edges.ts` history edge,
`repo/search-document.ts` (`i.name || ' · ' || pl.variety`),
`semantic/text.ts`, `repo/calendar-plantings.ts`, `plantingDisplayName` in
`repo/garden/index.ts`, `intents.fields.capture` (`ingredientId` → `plantId`;
native quick-capture needs a Plant picker), and `validatePlantingSource`
(`growsPlantId` vs `plantId`).

### 4.4 `Product`

`growsIngredientId` replaced by `growsPlantId` (FK → Plant, nullable), with no
deprecation release. Touchpoints: `growsIngredientIdFilter` in `product.ts`,
`repo/product/crud.ts`, `mappers.ts`, `services/product.service.ts`, the
`schema.ts` FK, Swift types. The orphaned-product detector is unaffected
because only bought Products exist.

### 4.5 Nothing else

No change to `Location`, `GardenEntry`, `Project`, `Task`, the calendar lane
or the ICS feed.

## 5. Static layer

### 5.1 `garden-guides.ts` — unchanged

Do not relax `windows.min(1)`; do not add uncited windows.

### 5.2 `garden-practice.ts` — new, `packages/schemas/src`

```ts
export const gardenPracticeSources = [
  { id: "…", name: "…", url: "…", reviewedAt: "2026-…" }, // same shape as guide sources
];

export const gardenPractice = {
  tomato: {
    starts: ["indoor", "bought"],
    successionWeeks: null,
    maturity: { fromSow: null, fromTransplant: [60, 85], source: "…" },
  },
  carrot: {
    starts: ["direct"],
    successionWeeks: 4,
    maturity: { fromSow: [60, 80], fromTransplant: null, source: "…" },
  },
  "gai-lan": {
    starts: ["direct"],
    successionWeeks: 4,
    maturity: {
      fromSow: [50, 70],
      fromTransplant: null,
      source: "estimate",
      note: "…how derived…",
    },
  },
  // …
} satisfies Record<string, GardenPractice>;
```

`starts: ("direct" | "tray" | "indoor" | "bought")[]` — deliberately distinct
from the source `method` enum so a household claim never reads as a
citation. Keys are a superset of the source guide keys; new practice-only
keys: asian greens / gai lan, broccoli raab, cilantro, dill, parsley, sorrel,
shiso, tomatillo, epazote, fenugreek, scallion, yardlong bean, saffron,
celery-leaf, alyssum, nasturtium, marigold. `maturity` is nullable per key;
`source` is a `gardenPracticeSources` id or `"estimate"` with a `note`.

**Research.** The first pass produced typical catalogue ranges without
opening a source page, so every entry ships as `"estimate"` with a note and
`gardenPracticeSources` is empty. Upgrading an entry to a citation means
adding the source and replacing `"estimate"` with its id.

### 5.3 Route viability

`garden-guides/windows.ts` gains `routes(plant, today)`: seed-based starts
(`direct`, `tray`, `indoor`) read the household-microclimate _sow_ windows,
`bought` reads _transplant_ windows; each start reports
`{ start, sowNow, plantOutWindow }`, rendered on Plant as short text ("indoor:
not now, sow Feb–Mar, plant out May–Jun · bought: plant out now"). Existing
month arrays only.

## 6. Tools and skills

- **`resolve_plants`** (MCP): `{ name, gardenGuideKey?, ingredientName? }[]`;
  matches `name` case-insensitively within the guide key, creates when
  missing, returns `PLANT-` ids with `created`. Follows `resolve_ingredients`
  (`repo/ingredient/crud.ts:222`, `findOrCreateWithShortcode`). Hint line in
  `mcp/server.ts`.
- **`garden-plan-import`**: resolve cultivars through `resolve_plants`; set
  verdicts from skip/maybe lists on Plant; fill Plant maturity from packet or
  listing data when the plan has it; vendor URLs stay on shopping Tasks;
  create a "review outcomes and verdicts" Task at season end.
- Web: Plant list and detail (generic manifest); Planting create and
  quick-capture pick a Plant; Ingredient detail gains Plants and loses the
  guide fields. Native follows the manifest.

## 7. Migration and rollout

One PR; brief downtime or breakage is accepted. Remeasure counts at execution
(2026-09-21: 61 plantings, ~35 seed Products, 5 garden projects).

The PR has two commits. The **expand** commit ("Add Plant entity…") keeps
the legacy columns declared as hidden storage and carries the backfill
script; the **contract** commit drops them and deletes the script.

1. Check out the expand commit and `db:push` against prod. It adds the Plant
   table and new columns, makes `Planting.ingredientId` nullable, and drops
   the FK constraints on the two legacy columns; nothing is removed.
2. From the same checkout, `pnpm --dir apps/web db:backfill-garden-plants`
   (dry run, prints a report), then again with `--write`. For each distinct
   (`Planting.ingredientId`, trimmed lower-cased `variety`) it creates a Plant
   named from the variety (or the ingredient when null) with the
   ingredient's `gardenGuideKey` and `ingredientId`, and sets
   `Planting.plantId`. Each Product with `growsIngredientId` takes the Plant
   its plantings grew (`sourceProductId`), else a species-level Plant for that
   ingredient. Idempotent; verified on synthetic data.
3. Merge the PR and deploy.
4. From main, `db:push` the drops: `Planting.variety`, `Planting.ingredientId`,
   `Ingredient.gardenGuideKey`, `Product.growsIngredientId`; `plantId`
   becomes NOT NULL (fails loudly if any planting was missed). Read the
   schema back.
5. Judgment calls over MCP afterwards: merge case-variant Plants; resolve
   "Unknown" tomatoes and "roma" to species rows; merge the stray `Sungold`
   ingredient; mark cleared-out beds' rows `finished`.

## 8. Validation

`garden-guides.unit` (key set unchanged); new `garden-practice.unit` (every
key has ≥1 start; source keys ⊆ practice keys; `min ≤ max`; every `source`
resolves or is `"estimate"` with a note); `windows.unit` (routes: seed starts
read sow windows, `bought` reads transplant windows, starts read
independently); expected-harvest table test (transplant beats sow, Plant beats
static, basis reported, null without a date); `garden/timeline.integration`
(guide band via Plant); `search-document` (planting display through Plant);
`product/list.integration` (`growsPlantId` filter); `entity-generator.unit`
and the catalog snapshot.

Acceptance: the current season plan is imported with the updated skill, and
its plant index, verdict lists, order list and calendar can be regenerated
from `entity list plant/planting/task` without the original document.

## 9. Documentation to change when code lands

- [CONTEXT.md](../../CONTEXT.md): add **Plant** ("a cultivar or species the
  household sows or buys as a transplant; grouped into a crop by its growing
  guide; carries the household's verdict and days to maturity"); rewrite
  **Planting** ("linked to its Plant") and **Growing guide**.
- [docs/garden.md](../garden.md), [docs/terminology.md](../terminology.md)
  §Garden, [docs/entities.md](../entities.md).
- `.claude/skills/garden-plan-import/` SKILL.md and references (Plant
  resolution, verdicts, season review Task).

## 10. Later, enabled by this plan

Per-cultivar history across seasons; a "what can I start today" page over
`routes` (optionally an "edge of window" label); a dashed expected-harvest
milestone on the timeline (verify `lifecycle.milestones` accepts a
projection); a `Plant.sowMonths` override if a cultivar falls outside its
crop window; Plant↔Ingredient many-to-many if "cook from the garden" needs it;
the photo-comparison and season-revision work in
[docs/todos.md](../todos.md).
