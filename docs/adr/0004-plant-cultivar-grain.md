# ADR 0004: Plant as the cultivar grain between Ingredient and Planting

Status: Accepted

## Context

A Planting names its crop through `ingredientId` and its cultivar through a
free-text `variety`. The growing-guide key hangs off Ingredient. Ingredient
therefore serves two grains at once: what a recipe calls for, and what the
household sows. The live data shows the strain — cultivars split across
generic and specific ingredients, the same cultivar spelled three ways, and
nothing that accumulates on "Sun Gold" from one season to the next. The
decisions a season plan is made of — which cultivar, why, whether to grow the
crop here at all, what happened last time — have no field.

## Decision

Introduce `Plant` (`PLANT-`) at **cultivar grain**: one record per named
cultivar, with species-level records allowed when there is no cultivar. A
Plant optionally links one Ingredient (null for non-food plants), and owns
`gardenGuideKey`, `latinName`, `breeding`, and a household verdict
(`yes | maybe | no` with a reason and date). Ingredient keeps only the recipe
grain plus a crop-level verdict; it loses the guide key and window
projections.

A Planting requires a `plantId` and loses its stored `variety` and stored
`ingredientId`; the ingredient remains a read-only projection through the
Plant. A Planting may record an optional `outcome` (`succeeded | failed`) with
a reason; finishing never requires one.

A Product that is a seed packet or a live plant references a Plant through
`growsPlantId`, replacing `growsIngredientId`. Such Products may be created
from vendor listings before anything is bought; they are catalog rows with no
movements until a purchase exists.

Reference data the household does not author — source planting windows, the
per-crop start methods and succession intervals — stays in checked-in static
files keyed by slug. Entities reference those slugs; static files never
contain shortcodes.

## Consequences

- Two column moves and one column removal, each expand → backfill → deploy
  → contract: `Ingredient.gardenGuideKey` → `Plant.gardenGuideKey`,
  `Product.growsIngredientId` → `Product.growsPlantId`, and
  `Planting.variety` removed. Sixty-one existing plantings are re-pointed by
  a scripted backfill; duplicates from free-text varieties are merged by hand,
  so Plant is mergeable from the start.
- The domain language changes: `Planting` is "linked to its Plant", the
  growing guide is associated with a Plant, and the `_Avoid_: Crop entity`
  note on Planting is reworded — Plant is the sown grain, not a recipe crop.
- The `garden-plan-import` skill's rule that Products exist only once bought
  is reversed for seeds and live plants.
- Not decided here and not implied: bed positions or footprints, irrigation
  zones, seed viability, harvest aggregation, or any maturity forecast.
