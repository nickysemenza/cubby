# Derive meal intake status from its date

Meal nutrition totals belong to the person and target Meal. A future Meal's
entered portions are planned; today and earlier are logged, using the household
timezone. Portions entered ahead automatically count when their date arrives.
Adding a Recipe without assigning an amount to a person contributes no intake.
The `meal.getNutrition` operation supplies the same food breakdown and totals to
web and native clients. It includes existing unconfirmed portions; the legacy
`confirmedAt` field and preparation API remain compatible but do not gate this
summary.

Recipe intake remains a `MealRecipePortion` of a preparation, including leftovers
served at another Meal. Direct Ingredient, Product, and named manual intake use
a Meal-owned `MealFoodEntry`, with a member or guest as eater. Food entries and
recipe portions share one scalar amount: `{ value, unit }`. The amount is the
recorded fact, and the source owns its conversions. There are no entry-level
conversion overrides or saved gram/batch-share snapshots.

Nutrition and weight resolve on read from current source data. Ingredient
nutrition resolves through its linked products; Product nutrition follows its
label/mappings. Recipe servings use the current serving count and preparation
scale; `batch` means the whole source preparation. Recipe yields also supply
conversion units, with actual cooked weight before estimated or recipe weight.
A serving or batch fraction can contribute nutrition without a gram yield.
Correcting a source conversion changes existing estimates, never the input.

Manual entries store a required name and sparse nutrient totals for the entered
portion. An optional amount describes that portion and does not multiply the
supplied nutrients. Blank nutrients mean unknown; explicit zero is known zero.
Missing conversions remain unavailable while preserving the entry. These entries
have no independent entity page or catalogue identity.

Deleting a Meal removes its owned entries. Product, Ingredient, and person
deletion is blocked by live direct entries; merges repoint them. Ingredient
merges repoint deleted entries too because absorbed ingredients are hard-deleted.
Recipe over-allocation is refused when current data proves it; missing
conversions alone do not prevent logging. Source corrections can reveal an
existing excess, which remains visible in the preparation summary.

Legacy gram inputs normalize to an amount with unit `g`. During the expand
migration readers accept legacy stored grams, while new writes persist amounts
only. Cleanup removes legacy columns after all deployed readers stop using them.
