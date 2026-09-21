# Garden

> Planned change: a `Plant` entity at cultivar grain, verdicts and outcomes —
> see [docs/plans/garden-plants-and-verdicts.md](plans/garden-plants-and-verdicts.md)
> and ADR 0004. Everything below describes the model as it is today.

Garden is `planting` and `gardenEntry`, two generic manifest entities with no
bespoke UI, workflow module, or hand-registered MCP tools. `/plantings` is
the list entry point; `/garden` is gone. See
[terminology.md](terminology.md#garden) for the naming glossary.

A **Planting** lives in at most one current `Location` (`locationId`, nullable)
and carries dates (`sowedOn`, `transplantedOn`, `finishedOn`), `status`
(`planned | growing | finished`), `variety`, `quantity` (text),
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
`packages/schemas/src/garden-guides.ts`, keyed by source and crop. An
Ingredient's `gardenGuideKey` (a plain `select` field) associates it with a
guide. `guideSowWindow`/`guideTransplantWindow` are read-only projections on
Ingredient and Planting, derived by
`apps/web/src/server/garden-guides/windows.ts` for the household
microclimate (`sunny`, falling back to `bay-area`) and rendered as a band on
the planting timeline. When updating the guide data, preserve source dates
and upstream attribution and run the focused guide test — do not infer tray
dates or maturity forecasts from planting windows.

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
