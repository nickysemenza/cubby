---
name: cubby-meal-logging
description: Log real-world eating events (what someone ate, for breakfast/lunch/dinner/snack, today or a past day) into Cubby's meal/recipe/ingredient nutrition model so daily intake rolls up correctly. Use when the user describes a meal or food they ate, wants calories/macros logged or estimated, mentions a specific product or "the recipe we made" as what they ate, or gives a second household member's portion of an already-logged meal.
---

# Log a meal in Cubby

Cubby has no direct "log this food" call. A real eating event is built from
existing entities — meal, recipe, ingredient, product — wired together so that
`get_daily_intake` and `get_meal_preparations` can roll it up per eater. The
whole skill is making that wiring match what actually happened, without
fabricating precision the user didn't give you.

## One dish, one recipe

Every physically distinct food a person ate is its own recipe-in-meal —
never bundled into one big ingredient list, even when several dishes were
plated together as "dinner." A shared pot of rice and a stir-fry are two
recipes, not one recipe with both ingredient lists. This is not stylistic:
`save_meal_recipe_preparation` confirms a *portion of one recipe* per eater,
so two dishes sharing a recipe object can't be portioned independently, and a
second eater's different amount of just the rice (not the stir-fry) has
nowhere to go.

Before writing a new recipe for a dish, check whether it already has one:

- **The user names it** ("the recipe we made a couple days ago", a product
  they scanned, a specific product shortcode) — reuse that exact recipe or
  product. Don't substitute a generic stand-in for something the user
  identified specifically, even if the generic version would resolve
  nutrition more cleanly. If more than one candidate matches, ask.
- **It's a staple/technique** worth having on hand again (roasted potatoes, a
  pot of beans) — give it real instructions, like an authored recipe, not a
  bare ingredient list. A one-off combination that's just "what was on the
  plate" (e.g. "sausage patties + cereal" as breakfast) doesn't need
  instructions — name it for what it is and list the ingredients.

## Find or create the meal

List `entity {action:"list", entity:"meal", filters:{from:<date>, to:<date>}}`
before creating — a meal for that day/type may already exist (including one
created by a different flow, like an `eating_out` placeholder). Pick a
`mealKind` that matches how the food arrived: `cooked` for made-at-home,
`eating_out`/`takeout` for a restaurant or delivery meal you're not going to
decompose into ingredients, `other` for a snack.

## Resolve each ingredient — don't let the resolver fork identity

`resolve_ingredients` creates a brand-new ingredient on anything short of an
exact name match, silently forking nutrition history that a near-duplicate
already carries. Before calling it, search:
`entity {action:"list", entity:"ingredient", filters:{nameFilter:"<short generic name>"}}`.
Prefer an existing ingredient that already has a linked Product with
nutrition data over minting a new one with a longer, more descriptive name —
the recipe's `rawLine` is where the descriptive detail belongs, not the
ingredient name.

The exception: when the fitting existing ingredient is already used by
several unrelated recipes and this dish needs different nutrition data
attached to it (a different prep, a different product), mint a fresh,
distinctly-named ingredient instead of repointing the shared one — attaching
a new Product/`fdc_id` to a shared ingredient changes the computed nutrition
of every other recipe that references it, immediately and silently.

## Resolve nutrition — cheapest reliable source first

1. **Exact product already in Cubby, UPC known** — `find_usda_food` or
   `find_or_create_product_by_upc`; the household's existing Product record
   often already resolves once a UPC/GTIN is on file (branded-food match by
   GTIN can fire automatically on read, so check the product's `food` field
   after adding the UPC before doing more work).
2. **Branded product, no UPC on file** — get the household's actual product
   page (their own copy's label, not a guessed URL) for the precise
   name/UPC/serving, then `search_usda_foods` by that exact name; verify the
   matched GTIN against the label before trusting it. Branded USDA records
   are label-only (some even omit protein); when the branded food is a
   single-ingredient generic (frozen wild blueberries, rolled oats), an
   explicit SR Legacy/Foundation `fdc_id` gives the same macros plus
   micronutrients — keep the UPC for identity and set `fdc_id` for nutrition.
3. **Fresh/generic ingredient** (rice, potato, tomato, chicken breast) —
   `search_usda_foods` (`sr_legacy_food`) for the prep that matches how it
   was eaten (raw vs. cooked/baked/roasted — a raw-basis figure on a
   cooked-weight portion runs calories hot by ~15–25%, flag this when no
   cooked entry exists). Create `"<name> (generic)"` as a Product carrying
   the `fdc_id`, linked via `ingredientId` — see the shared-ingredient
   exception above for when this needs a new ingredient too.
4. **No USDA match at all** (a spice blend, a user-given macro estimate for
   an uncomposed meal like "office lunch, roughly 1000 kcal") —
   `Product.labelNutrition` (`servingGrams` + `nutrients`), sourced as an
   explicit estimate. For a one-off estimate that won't hold for next time
   (today's specific office lunch), name the Product for that specific day so
   a future edit to it can't retroactively change today's log.

Trace seasonings (a pinch of salt, a dusting of paprika) aren't worth an
ingredient line — skip them, the same as you'd skip water. A seasoning with
real bulk or macros (a spoonful of taco seasoning, oil used to stir-fry or
roast something) is worth a small estimated line even without a USDA match.

A Product linked to the wrong ingredient (a frozen-wild-blueberry bag on
`fresh blueberries`) is fixed by repointing the Product's `ingredientId`,
not by renaming or repointing the ingredient — the old ingredient keeps its
other products and every recipe using it keeps resolving.

## Make every line resolve

`explain_recipe_costing {id, detail:"lines"}` is the diagnostic: each line
reports `missing.{price,weight,nutrients}` and the unit path it found. Read
it before touching data; the two usual gaps:

- **A nutrient-free line** (creatine, a sweetener, a supplement) stays
  unmapped under `usdaUnavailable: true` and ingredient `naKinds` — those
  clear the product's data-quality gap, not recipe coverage. A zero-value
  `labelNutrition` (`servingGrams` = one dose, all macros `0`) is what makes
  the line count as covered.
- **Cost needs a unit path to the priced unit.** Product price is per `each`,
  so a line in `scoop`/`g` resolves only if the mappings chain all the way
  there: `1 scoop = 5 g` alone leaves cost `—`; adding `1 each = 500 g`
  (package servings × dose) closes it. Volume lines need `cup`/`tbsp` → `g`
  the same way.

After a mapping or label fix the persisted totals recompute on the next read
(`persisted.stale: false` in the explain output); a `—` still showing in the
web recipe table is a stale page, not a data gap.

## Wire it into the meal

`add_recipe_to_meal` (scale `1` unless you're intentionally logging a
fraction of an authored multi-serving recipe — e.g. you cooked the full
4-serving version but this eater only had one serving, so `scale: 0.25`).
Adding the recipe alone does **not** log intake — `get_daily_intake` stays
empty until a portion is confirmed. Pull each new join's `mealRecipeId` from
`get_meal_preparations`, then `save_meal_recipe_preparation` per eater:

- `grams` — what that person actually ate, in the units they gave you.
- `actualYieldGrams` — the batch's real measured total, when you have one.
  When you built the recipe's own ingredient quantities to exactly match one
  eater's plate (the common case for a single-eater dish), that quantity
  *is* the yield — set it to the same number as `grams`.
- `estimatedYieldGrams` — use this field, not `actualYieldGrams`, whenever
  the total is a guess (an existing multi-serving recipe with no recorded
  weight, a big shared pot). State the estimate and its basis to the user;
  ask instead of guessing when it's load-bearing and they might just know it.

**A second eater sharing the same prepared batch, added later:** don't just
add their `grams` — the recipe's own declared ingredient quantities (and the
yield) were sized to the *first* eater alone, so bump both to the true
combined total (first eater's grams + second eater's grams, scaled
proportionally if there were secondary ingredients like a stir-fry's oil)
before adding the second `"set"` change. Otherwise the total nutrition being
divided between them is still only the first eater's portion, undercounting
what the second eater ate. The first eater's already-confirmed portion needs
no edit — grams portions are always a *share of the recipe's total*, not an
absolute that has to be recomputed.

## Verify and report

`get_daily_intake(date, partyId)` per eater who got a portion — confirm
`status: "logged"` with non-null `nutrition` and the new meal present, not
`meals: []` (the tell that a portion was never confirmed). Report back a
compact per-meal kcal/protein/carbs/fat breakdown, and call out anything that
was estimated rather than measured (a yield guess, a labelNutrition estimate,
a raw-basis figure standing in for a cooked one) so the user knows which
numbers to trust less.
