---
name: cubby-meal-logging
description: Log a real eating event into Cubby's meal, recipe, ingredient, and nutrition model. Use when the user describes food eaten, asks to log calories/macros, identifies a Product/recipe they ate, or adds another person's portion.
---

# Log a meal in Cubby

Model what happened without fabricating precision. A distinct dish is a
distinct recipe in the meal: portions are per recipe per eater, so shared rice
and stir-fry cannot be one ingredient list.

## Read and decide

Start with summary/count reads, then page through a narrowed result, then fetch
the full record only when it is selected. `list_problems` defaults to counts;
to inspect a class, call it with explicit `type`, `pageIndex`, and `pageSize`
(for example `{ type: "…", pageIndex: 0, pageSize: 25 }`).
`explain_recipe_costing` defaults to
`detail: "lines"`; request `detail: "full"` only when nutrient totals or drift
are needed.

Reuse an exact named recipe or Product. If several candidates match, ask. A
repeatable staple deserves instructions; a one-off plate can be an accurately
named ingredient list. List meals for the date before creating one and choose
`cooked`, `eating_out`/`takeout`, or `other` to match how it arrived.

Search an ingredient before `resolve_ingredients`: that resolver creates a new
one without an exact match. Prefer an existing nutrition-linked ingredient; put
descriptive detail in `rawLine`. Create a distinct ingredient only when a new
nutrition mapping would alter unrelated recipes using the shared one.

## Resolve nutrition and lines

Use the cheapest reliable source: exact existing Product/UPC, exact branded
label plus USDA, a prep-matched generic USDA food, then an explicit
`labelNutrition` estimate. Preserve actual UPC identity even when a generic
`fdc_id` gives better nutrition. Skip trace seasonings and water; include oil or
material seasoning. Repoint a wrongly linked Product, never a shared ingredient
whose existing recipes must keep their nutrition.

Use `explain_recipe_costing` lines to find missing coverage. A nutrient-free
item requires zero `labelNutrition` to count as covered. Cost requires mappings
from line unit to the priced unit. Read again until `persisted.stale: false`;
a stale browser recipe table is not a data gap.

Read [nutrition and portion details](references/nutrition-and-portions.md) for
USDA choice, estimates, unit mapping, shared-batch changes, or uncertain yield.

## Log and verify

Add the recipe to the meal (normally `scale: 1`), get its `mealRecipeId`, then
save a preparation for each eater. Record measured `grams` and actual batch
yield when known; use `estimatedYieldGrams` for a guess and state its basis.
When a later eater shares a batch originally sized for one person, enlarge the
recipe quantities and yield to the true combined amount before adding their
portion.

Verify `get_daily_intake(date, partyId)` for every eater: it must be `logged`,
have nutrition, and include the meal. Report per-meal kcal/protein/carbs/fat
and clearly name every estimate.
