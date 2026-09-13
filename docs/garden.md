# Garden

Garden is available on the web at `/garden` and in the native app's Browse area.
Start by adding an existing or new Location as a bed, tray, or other growing area.
Record existing crops without inventing dates, or add planned plantings for later.

A Planting links an Ingredient to its growing Location and optional source
Product. Product's **Grows** relationship is separate from its edible Ingredient
relationship. Neither planting nor harvesting changes Inventory.

Use Start to sow or transplant a planned crop, Move everything for a whole
transplant, or Move some seedlings to create a child while retaining the original
tray planting. Finish selected crops when resetting a bed. Entries and photographs
remain available after finishing, and retain the Location where they happened.

## Journals and confirmed location history

A planting journal always includes entries directly attached to that planting.
It can also include a whole-bed entry only when the entry date falls within a
confirmed location period for that planting. Period ends are inclusive, so a
same-day move can legitimately give both the source and destination context for
that date. Journal paging and ordering happen on the server; an entry is emitted
once even when it is both direct and whole-bed context.

Planting workflows write location periods transactionally. Starting from seed
or transplanting records an `actual` start; recording an already-existing plant
uses `recorded` because the date means when Cubby was told, not necessarily when
the plant arrived. A period-date correction confirms only changed dates as
`actual` and updates the workflow entry that established the period in the same
transaction. Ordinary observations and harvests may be corrected later,
including their date, Location, and optional Planting. Move entries keep their
Location, Planting, and date as structural history.

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
