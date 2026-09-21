---
name: garden-plan-import
description: Turn a seasonal garden plan document (beds, per-bed per-season plantings, a dated work calendar, a shopping list, a plant index with variety/source/seed-stock, watering/lessons prose) into Cubby Locations, a season Project, Tasks, and planned Plantings via the MCP entity/entity_batch tools. Use when the user supplies a garden plan, seasonal plan, bed plan, or planting plan and wants it imported or ingested into Cubby.
---

# Import a seasonal garden plan

> Planned change: cultivars become `Plant` records and seed/live-plant
> Products may precede purchase — see
> `docs/plans/garden-plants-and-verdicts.md`. Until that lands, this skill
> is current.

Cubby has no bespoke garden workflow — a plan becomes ordinary generic-entity
records: `Location`s for beds, one `Project` for the season, `Task`s for its
calendar rows and shopping lines, and planned `Planting`s. This skill is the
playbook for that decomposition, not a new capability. See
[docs/garden.md](../../../docs/garden.md) for the underlying model.

## Read this model first

```
Location (bed/planter/area) ──< Planting >── Ingredient (crop; gardenGuideKey optional)
                                    │
                                  taskId
                                    │
                                  Task >── Project (kind: "garden")
```

- A Planting lives in **one** Location (`locationId`, nullable) and carries
  `status: planned | growing | finished`. **Every planting this skill creates
  is `status: "planned"`, even a plan row that says "plant now."** The import
  captures the plan's *intent*; sowing it is a later, separate edit the
  household makes (setting `sowedOn` and flipping `status`) — this skill
  never claims work already done.
- One `Project` per season (`kind: "garden"`) holds every Task and planned
  Planting for that season. Watering schedules, lessons learned, and
  skip-lists that are prose, not a record, go in `Project.notes` wholesale —
  do not decompose narrative into fake records to house it.
- A `Task` exists for every calendar row and every shopping-list line. A
  planting's `taskId` points at the Task that will do the sowing/transplant,
  so "what does this plan still ask of me" is always `entity list task
  {filters:{projectId}}`.
- Seed packets become `Product`s only once **bought** — run `purchase-import`
  at that point and set the Planting's `sourceProductId`. A plan's shopping
  list is Task rows, not Products; the seed drawer itself is Inventory, not
  modelled by this skill.
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
4. Create one `Project` per season named for the plan (`kind: "garden"`).
   Put watering schedules, lessons, and skip-lists in `notes`.
5. Create a `Task` per calendar row and per shopping-list line, all under
   that Project (`projectId`). Due dates come from the plan's headings.
   Resolve `subjectProductId` with `resolve_products` when a matching
   Product already exists; never create one for a not-yet-bought line.
6. Resolve crop identity in one batch with `resolve_ingredients`, creating
   Ingredients only for crops the plan actually names. Set `gardenGuideKey`
   on an Ingredient only when a matching key already exists in
   `packages/schemas/src/garden-guides.ts` — never invent one.
7. Create the planned Plantings: `status: "planned"`, `locationId`,
   `variety`, `quantity` (text, as the plan states it — count or weight),
   `plannedWindow` (text, as the plan states timing), `taskId` pointing at
   the Task from step 5 that will plant it. Leave `sowedOn`/`transplantedOn`
   unset at import time (see [references/mapping.md](references/mapping.md)
   for the later, normal shape of nursery-bought stock). No planned Planting
   carries photos — planting has no photo gallery.
8. Verify in batches: list Plantings with the created `taskId` filters and
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
