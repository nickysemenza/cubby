# Nutrition and portions

Use an exact known Product with UPC first. For a branded item without a stored
UPC, inspect the actual label/product page, search USDA by exact name, and
verify GTIN. Branded records can lack nutrients; for a single-ingredient food,
keep UPC for identity and use a prep-matched SR Legacy/Foundation `fdc_id` for
nutrition. Raw-basis nutrition for a cooked-weight portion can materially
overstate calories; flag the limitation when no cooked entry exists.

For a fresh generic food, create a `"<name> (generic)"` Product with its
`fdc_id` and ingredient link. For a one-off estimate that should never be
revised retroactively, name the Product for that particular meal/date and use
explicit `labelNutrition`. Nutrient-free items need a serving mass and all-zero
macros, rather than `usdaUnavailable`, to clear recipe coverage.

`explain_recipe_costing` identifies missing price, weight, and nutrients. A
price per `each` needs mappings all the way from the recipe unit: `1 scoop = 5
g` is insufficient without the package mapping such as `1 each = 500 g`.
Volume units likewise need a path to grams. Persisted totals recompute on the
next read.

For a shared batch, `grams` is each person's share of the recipe's total;
confirmed first-eater grams stay valid after increasing the full recipe. Update
ingredient quantities and the batch yield proportionally before recording a
second share. Ask when an unknown yield is material; otherwise keep the yield
explicitly estimated.

`add_recipe_to_meal` returns its `mealRecipeId`; retain that occurrence
handle, because adding the join alone does not log intake. Save each eater's
preparation against that join. A single-eater recipe built to the plate has
`actualYieldGrams` equal to `grams`. Use `estimatedYieldGrams` rather than
`actualYieldGrams` for a guess. Keep `scale: 1` unless intentionally logging a
fraction of an authored multi-serving recipe.
