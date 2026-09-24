# Garden

Garden is `plant`, `planting` and `gardenEntry`, three generic manifest entities.
`/plantings` and `/plants` are the record entry points. `/garden-workbench` is a
read-only view of guide timing, household practice, and planting plans; it has
no write workflow or hand-registered MCP tools. `/garden` is gone. See
[terminology.md](terminology.md#garden) for the naming glossary.

A **Plant** is a cultivar ("Sun Gold F1") or, without one, a species
("Fenugreek"). Its `gardenGuideKey` is the crop; `verdict` (`yes | maybe |
no`) is the household's decision, with the reason in `notes`; a crop-level
"never here" is a species Plant with verdict `no`. `daysFromSowMin/Max` and
`daysFromTransplantMin/Max` come from the packet or vendor listing only.
`ingredientId` is informational. Its display name is `"<name> · <crop
label>"`.

A **Planting** names its `plantId` and lives in at most one current `Location` (`locationId`, nullable)
and carries dates (`sowedOn`, `transplantedOn`, `finishedOn`), `status`
(`planned | growing | finished`), `outcome` (`succeeded | failed`, set at
season review; any harvest is `succeeded`), `quantity` (text),
`plannedWindow` (text), an optional `sourceProductId`, an optional `taskId`,
and `notes`. There are no lifecycle verbs — Edit is the only hero action. A
move is editing `locationId`; the audit log and timeline record the from/to
location as the location history. Sowing in trays and transplanting to a bed is
`sowedOn` + `transplantedOn` on the same planting; its current location may
change along the way. A planting has no photo gallery of its own
(`capabilities.images: false`) — see "Photos" below.

A nursery-bought seedling never gets a `sowedOn`: it carries `transplantedOn`
only. The timeline's `lifecycle.start` is a generic ordered fallback
(`["sowedOn", "transplantedOn"]` for planting) — the interval starts at the
first non-null field, so a bought seedling's interval starts at
`transplantedOn` and renders marked "Inferred" (the row's `confident: false`)
rather than needing an origin enum.

The Plantings list has an opt-in Schedule beside Table and Timeline. It groups
records by current location, with one row per Planting and separate marks for
recorded dates and derived expected harvest. Source-linked guide windows sit
on reference rows for represented crops. The workbench compares these records
with source-specific recurring windows on a selected twelve-month year axis;
that axis does not turn a recommendation into a household plan. `plannedWindow`
remains text in an undated lane. Schedule and workbench record views load all
pages before rendering their result.

A **GardenEntry** is a dated `note | harvest` against a required `Location`,
explicitly associated with zero or more Plantings, with photos. Explicitly
associated entries remain in each selected planting's journal regardless of
where or when the entry was recorded. An entry with no live planting
associations is whole-area context: it appears in a planting's journal when it
was recorded at that planting's current location and its `observedOn` falls in
`[coalesce(sowedOn, transplantedOn, createdAt), finishedOn]`. An entry linked
to any planting is not inferred into other plantings' journals merely because
they share its location.

## Photos

Journal entries are the only photo surface in the garden model — a planting
carries no gallery, `pendingImageIds`, or image fields of its own. The
plantings list still shows a thumbnail: the display-image policy borrows the
latest journal entry's first photo (newest `observedOn` first) for that
planting, falling back to the linked seed Product's cover image when no
entry has one, and to nothing when neither exists.

`Location.type` includes `bed` and `planter` (plus `area` for open ground),
and a generic `notes` textarea. A product-linked Location (a bought raised
bed) still carries a `type` — the product supplies identity and price, and
`type` separately states the form factor (`bed`, in that case); the two are
independent, not mutually exclusive. Growing-area-ness is derived: a
location with plantings shows Plantings/Garden-entries relation sections;
`hideWhenEmpty` sections skip themselves when their first page is empty, so
a non-growing location shows neither.

## Guides and the household microclimate

Curated sow/transplant windows are data in
`packages/schemas/src/garden-guides.ts`, keyed by source and crop. Household
practice — `starts` (`direct | tray | indoor | bought`), `successionWeeks`,
and crop-level `maturity` ranges marked with a cited source or `"estimate"`
— is `packages/schemas/src/garden-practice.ts`, whose keys are a superset of
the guide keys. A Plant's `gardenGuideKey` associates it with both.
`guideSowWindow`/`guideTransplantWindow` are read-only projections on Plant
and Planting; `routes` on Plant reads each start route against this month
(seed routes against sow windows, `bought` against transplant windows); a
Planting's `expectedHarvestStart/End` adds the Plant's packet days, else the
crop maturity, to `transplantedOn`, else `sowedOn`. All are derived by
`apps/web/src/server/garden-guides/windows.ts` for the household
microclimate (`sunny`, falling back to `bay-area`) and rendered as a band on
the planting timeline. When updating the guide data, preserve source dates
and upstream attribution and run the focused guide test — do not infer tray
dates from planting windows or add uncited windows to the guide file.

## Seasonal plans

A season's plan is a `Project` plus due-dated `Task`s (calendar rows and
shopping lines; `Task.subjectProductId` when a Product exists) plus planned
`Planting`s carrying `taskId`. Seed packets become Products through
`purchase-import` only once bought; the seed drawer is ordinary Inventory.
Turning an AI-written seasonal plan document into these records is the
`garden-plan-import` skill (`.claude/skills/garden-plan-import/`).

## Native photo import and calendar

Native Photos offers a generic "New ‹entity›" destination for any gallery
entity with a create contract — garden entry, not planting, since planting
has no gallery — photos become `pendingImageIds`, and any create field with
`control.initial: "today"` prefills from the earliest capture date. No
day-grouping.

The `planting` calendar lane emits one item per milestone (`sowed`,
`transplanted`, `finished`) as the `garden` ICS feed (also folded into
`all`); ICS-only, matching the tenet that garden data has no reservation or
locking semantics.

The [local journey coverage map](agents/core-journey-e2e.md) links the
planting and journal browser check and names the remaining native input path.
