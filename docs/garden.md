# Garden

Garden is available on the web at `/garden` and in the native app's Browse area.
`/plantings` redirects to `/garden`; the `/plantings/$shortcode` detail route
is unchanged and stays the canonical planting-detail URL. Start by adding an
existing or new Location as a bed, tray, or other growing area. Record
existing crops without inventing dates, or add planned plantings for later.
See [terminology.md](terminology.md#garden) for the naming glossary (growing
area, planting, entry, anchor, journals).

A Planting links an Ingredient to its growing Location and optional source
Product. Product's **Grows** relationship is separate from its edible Ingredient
relationship. Neither planting nor harvesting changes Inventory.

Move, Split, and Finish all live in the planting's Actions menu on every
client — there is no separate toolbar or context-specific entry point per
client. Use Start to sow or transplant a planned crop, Move everything for a
whole transplant, or Move some seedlings to create a child while retaining the
original tray planting. Finish a planting when resetting a growing area; there
is no "Finished" state offered at creation time. Entries and photographs
remain available after finishing, and retain the Location where they happened.
Apple does not offer a bed-context toggle when creating or browsing a
planting — a planting's inclusion under a growing area is a rule derived from
its location history, not a per-screen option.

Plantings and garden entries both carry a server-computed `displayName`
(`"<crop name>[ · <variety>]"` for a planting; `"<Note|Harvest|Move> · <date>
· <area name>"` for an entry), are searchable, and surface hovercards
wherever they're referenced. A planting's detail page has no separate photo
gallery — its journal is the only photo surface; photos attach through
journal entries, not a standalone upload.

The Location page of a growing area shows a Garden section: its kind,
conditions, current plantings, the area's journal, and a Log entry action.

## Anchor entries and location history

Every location period a planting occupies is anchored by exactly one
structural `GardenEntry`: the entry `startPlanting` writes when a planting
first enters a location, or a `move` entry for every subsequent transfer.
Anchor and move entries carry `anchorsPeriod: true` in `gardenEntryOut` so
clients lock their location, planting, and date fields — those are corrected
only through location history, never through the entry edit form. Ordinary
Note and Harvest entries stay freely editable, including their date,
Location, and optional Planting.

## Journals and confirmed location history

A planting journal always includes entries directly attached to that planting.
It can also include a whole-area entry only when the entry date falls within a
confirmed location period for that planting. Period ends are inclusive, so a
same-day move can legitimately give both the source and destination context for
that date. Journal paging and ordering happen on the server; an entry is emitted
once even when it is both direct and whole-area context.

Planting workflows write location periods transactionally. Starting from seed
or transplanting records an `actual` start; recording an already-existing plant
uses `recorded` because the date means when Cubby was told, not necessarily when
the plant arrived. A period-date correction confirms only changed dates as
`actual` and updates the anchor entry that established the period in the same
transaction. Ordinary observations and harvests may be corrected later,
including their date, Location, and optional Planting. Move entries keep their
Location, Planting, and date as structural history, matching anchor entries.

## `garden.options`

`garden.options` returns the garden-scoped option set consumed by pickers:
growing areas (Locations carrying a `gardenKind`), Ingredients referenced by
at least one planting or carrying a `gardenGuideKey`, and Products with a
`growsIngredientId`. It also accepts an optional `search` string (2+
characters) that name-prefix-matches Locations/Ingredients/Products beyond
that default scoped set, for attaching a planting to an area or ingredient
the garden doesn't already reference.

## Garden calendar

A read-only **planting** calendar lane emits one item per recorded milestone
(planned, sowed, transplanted, finished) per planting, and is exposed as the
`garden` ICS feed. The `all` feed is unchanged and still includes it. Two-way
CalDAV collections remain meal and task only — the garden lane is ICS-only,
matching the tenet that garden data has no reservation or locking semantics.

Photos save as dated batches without subject lifting or background removal.
Failed uploads retain the open form and selected files for retry. There is no
durable offline draft storage.

## Reference data

`apps/web/src/server/garden/planting-guides.json` contains the source registry and
crop windows. Both clients consume it through `garden.guides`. Ingredient's
`gardenGuideKey` is an explicit association; the guide file does not create
Ingredients. Sources can disagree. The UC calendars' seed symbol is represented
as `sow`, while an explicit in-bed recommendation is `direct-sow`.

When updating the file, inspect the original calendar layout, preserve source
dates and upstream attribution, and run the focused guide tests. Do not infer
tray dates or maturity forecasts from planting windows.

## Schema rollout

This journal update adds the internal PlantingLocationPeriod table to the
existing Garden schema. Follow Cubby's Drizzle schema-push and production
preflight process before deploying code that reads it.

Existing plantings can remain without confirmed location history. Open a
planting's Location history and confirm **In this location since** to create its
first period directly. Matching older bed photos then appear automatically.
No backfill script is needed; entries and photos are never duplicated. Planned
plantings do not establish presence, and unknown earlier dates stay unknown.

Do not infer a period from a harvest or ordinary observation alone. Preserve
existing columns and Location's product/type constraint. Validate the schema on
the target database after the additive change; local tests do not apply
production DDL.
