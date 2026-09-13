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

The database additions are Planting, GardenEntry, GardenEntryImage, and nullable
garden fields on existing entities. Follow Cubby's existing Drizzle schema-push
and production preflight process before deploying code that reads those columns.
This feature does not require a household-data backfill. Do not remove or rename
existing columns, and preserve Location's product/type constraint. Validate the
schema on the target database after the additive change; local tests do not apply
production DDL.
