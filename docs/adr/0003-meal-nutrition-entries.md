# Derive meal intake status from its date

Meal nutrition totals belong to the person and target Meal. A future Meal's
entered portions are planned; today and earlier are logged, using the household
timezone. Portions entered ahead automatically count when their date arrives.
Adding a Recipe without assigning an amount to a person contributes no intake.
The `meal.getNutrition` operation supplies the same food breakdown and totals to
web and native clients. It includes existing unconfirmed portions; the legacy
`confirmedAt` field and preparation API remain compatible but do not gate this
summary.

Recipe intake remains a weighed `MealRecipePortion` of a preparation, including
leftovers served at another Meal. Direct Product and named manual intake use a
small Meal-owned `MealFoodEntry`, with a member or guest as eater. Product entries
store grams; a serving shortcut converts using the package label's serving
weight before USDA mappings, or a user-entered package conversion. Manual entries
store a required name and sparse nutrient values for the entered amount. Blank
nutrients mean unknown; explicit zero is known zero. These entries have no
independent entity page or catalogue identity.

Both kinds of intake follow current source nutrition while keeping recorded
amounts fixed. Missing recipe yield or nutrition remains unavailable or partial.
Deleting a Meal removes its owned entries; Product and person deletion is blocked
by live direct entries, and merging either repoints those entries.
