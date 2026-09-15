---
version: 1
slug: "src-routes-authenticated-meals-index-tsx"
primary_target: "src/routes/_authenticated/meals.index.tsx"
related_targets: ["src/app/meals/daily-nutrition.tsx","src/app/meals/meal-nutrition-summary.tsx","src/app/meals/meal-detail-page.tsx","src/app/meals/add-food-dialog.tsx"]
---

# Meal nutrition surface brief

- **Scope and mode:** The authenticated Meals nutrition view (`/meals?view=nutrition&date=…`), its embedded meal-detail summary, and the compact Home projection; Operate.
- **Audience and job:** A trusted household member checks each person's intake for a selected day, then traces a total through a meal to the recorded food and amount.
- **Action, proof, and constraints:** The first viewport pairs date navigation and `Add food` with each person's calories, protein, carbs, and fat. The full view groups foods beneath each person by meal and exposes meal subtotals; food rows lead with the amount, preserve fractional servings, and link their real product or recipe source. Unknown nutrition remains unavailable (`—`) rather than becoming zero; `+` marks a known subtotal with missing food nutrition. Future dates say `Planned` once; today and past dates have no status label.
- **Chosen direction and memorable moment:** Extend Porcelain Transit as a fine-rule macro matrix: people sit side by side on wide screens and stack on phone, while white planes, hairlines, tabular measures, and restrained cobalt keep the reading task primary. The memorable sequence is person → macro total → meal subtotal → food and amount → secondary detail or edit.
- **Interaction and responsive form:** Mobile keeps the same reading order with 44px controls and shared bottom-sheet dialogs. `Add food` is one source chooser for Products, Recipes, and named manual food; product entry leads with grams or fractional servings, while manual macros leave unknown values blank. Additional nutrients, photos, preparation, and editing remain secondary disclosures or detail paths.
- **Unresolved decisions:** None. The composition, source choices, truth states, and responsive behavior are implemented and specified; no concept seed applies to this narrow extension.
- **Native projection:** Swift meal detail, daily Nutrition, and Today use the same summary read. Native daily navigation includes a date picker and Previous/Today/Next controls. Standard macro grids remain compact; accessibility Dynamic Type uses one full-width macro per row so values, units, and partial markers stay readable.
