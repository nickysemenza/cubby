---
name: garden-plan-import
description: Turn a seasonal garden plan document (beds, per-bed per-season plantings, a dated work calendar, a shopping list, a plant index with variety/source/seed-stock, grow/skip verdicts, watering/lessons prose) into Cubby Locations, a season Project, Tasks, Plants, and planned Plantings via the MCP entity/entity_batch tools. Use when the user supplies a garden plan, seasonal plan, bed plan, or planting plan and wants it imported or ingested into Cubby.
---

# Import a seasonal garden plan

Cubby has no bespoke garden workflow — a plan becomes ordinary generic-entity
records: `Location`s for beds, one `Project` for the season, `Task`s for its
calendar rows and shopping lines, and planned `Planting`s. This skill is the
playbook for that decomposition, not a new capability. See
[docs/garden.md](../../../docs/garden.md) for the underlying model.

## Read this model first

```
Location (bed/planter/area) ──< Planting >── Plant (cultivar/species; gardenGuideKey = crop,
                                    │                verdict, days to maturity,
                                  taskId             ingredientId informational)
                                    │
                                  Task >── Project (kind: "garden")
```

- A Planting lives in **one** Location (`locationId`, nullable) and carries
  `status: planned | growing | finished`. **Every planting this skill creates
  is `status: "planned"`, even a plan row that says "plant now."** The import
  captures the plan's _intent_; sowing it is a later, separate edit the
  household makes (setting `sowedOn` and flipping `status`) — this skill
  never claims work already done.
- One `Project` per garden year (`kind: "garden"`) holds every Task and
  planned Planting for that year. The year runs from the fall reset to the
  end of summer (Sept 1–Aug 31 where winters are mild), so a fall sowing and
  the summer crop that follows it share a Project. Watering schedules, lessons learned, and
  skip-lists that are prose, not a record, go in `Project.notes` wholesale —
  do not decompose narrative into fake records to house it.
- A `Task` exists for every calendar row and every shopping-list line. A
  planting's `taskId` points at the Task that will do the sowing/transplant,
  so "what does this plan still ask of me" is always `entity list task
{filters:{projectId}}`.
- A Planting names its `Plant` (`plantId`), never free-text variety. A Plant
  is one cultivar ("Sun Gold F1") or, with no cultivar, the species
  ("Fenugreek"); its `gardenGuideKey` is the crop. Plant verdicts
  (`yes | maybe | no`) carry the plan's grow/skip decisions; the reasoning
  goes in `Plant.notes`. A crop-level "never here" is a species Plant with
  verdict `no`.
- Seed packets and live plants become `Product`s only once **bought** — run
  `purchase-import` at that point, set `Product.growsPlantId` and the
  Planting's `sourceProductId`. A plan's shopping list is Task rows (vendor
  URL and price in the Task notes), not Products; the seed drawer itself is
  Inventory, not modelled by this skill.
- Bed grid positions (row/section within a bed) are not modelled — no child
  Locations, no position field. If the plan places "row 2 of bed 3," that
  detail lives in the Planting's `notes` or `quantity` text, not a new
  Location.

## Load references only when needed

- Field-by-field mapping for Location/Project/Task/Planting, the
  `gardenGuideKey` rule, and what to leave out:
  [references/mapping.md](references/mapping.md).
- A worked example (three plan rows → records) with placeholder shortcodes:
  [references/fixtures.md](references/fixtures.md).

## Default workflow

1. Read the relevant tool input schema first when a required field or action is
   uncertain; consult the catalog only if the schema is insufficient. The
   focused mapping below is the normal path.
2. Read the whole plan document before writing anything. Note every bed
   name, every dated heading, every shopping line, and every plant-index
   entry (variety, source, seed stock) — a partial read produces a partial
   import that reads as complete.
3. Resolve Locations. Search existing Locations by name before creating any
   (`entity {action:"list", entity:"location", filters:{search:"..."}}` or
   `global_search`). Create only what's missing: beds `type: "bed"`, pots/
   containers `type: "planter"`, open ground `type: "area"`. Set `type`
   whether or not the Location links a Product (a bought raised bed still
   carries `type: "bed"`) — the Product supplies identity and price, `type`
   states the form factor; the two are independent. Soil/condition notes
   from the plan go on `Location.notes`.
4. Reuse the garden year's `Project` (`kind: "garden"`, dated Sept 1–Aug 31)
   if one exists; otherwise create it. Put watering schedules, lessons, and
   skip-lists in `notes`.
5. Create a `Task` per calendar row and per shopping-list line, all under
   that Project (`projectId`). Due dates come from the plan's headings.
   Resolve `subjectProductId` with `resolve_products` when a matching
   Product already exists; never create one for a not-yet-bought line.
6. Resolve cultivars in one batch with `resolve_plants`
   (`{ name, gardenGuideKey?, ingredientName? }[]`). `gardenGuideKey` must be
   an existing key in `packages/schemas/src/garden-practice.ts`
   (`gardenCropKeys`) — never invent one. Then set on each Plant what the
   plan states: `verdict` from its grow/maybe/skip lists (reason in
   `notes`), and `daysFromSowMin/Max` or `daysFromTransplantMin/Max` only
   from a packet or vendor listing the plan cites (URL in `notes`) — crop
   estimates already live in `garden-practice.ts`.
7. Create the planned Plantings: `status: "planned"`, `locationId`,
   `plantId`, `quantity` (text, as the plan states it — count or weight),
   `plannedWindow` (text, as the plan states timing), `taskId` pointing at
   the Task from step 5 that will plant it. Leave `sowedOn`/`transplantedOn`
   unset at import time (see [references/mapping.md](references/mapping.md)
   for the later, normal shape of nursery-bought stock). No planned Planting
   carries photos — planting has no photo gallery.
8. Create one end-of-season Task in the Project, "Review outcomes and
   verdicts", due at the season's end: it sets each Planting's
   `outcome` (`succeeded` if it yielded anything, else `failed`, reason in
   `notes`), `status: finished`, `finishedOn`, and updates Plant verdicts.
9. Verify in batches: list Plantings with the created `taskId` filters and
   Tasks with the Project filter, then compare counts and named rows to the
   plan. Do not make one verification read per row.

## What NOT to import

- Prose the plan states as reasoning or caveats (why a bed is resting, a
  watering-frequency rule of thumb) — that's `Project.notes`, not a record.
- Bed grid positions and row layout — not modelled anywhere.
- Watering timer schedules beyond a `notes` mention — Cubby has no
  reservation or timer semantics (see the trusted-household tenet in
  [README.md](../../../README.md#tenets)).
- Seed packets for lines not yet purchased — those are Task shopping lines,
  never speculative Products.
- Photos on a planned Planting — planting has no photo gallery
  (`capabilities.images: false`); garden photos live only on GardenEntry,
  added later once the household logs entries.
