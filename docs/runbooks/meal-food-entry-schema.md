# Meal food entry schema rollout

Meal nutrition adds the internal `MealFoodEntry` table. The production schema
change must be applied before application code that reads or writes food entries
is deployed.

This is an additive expansion: create the table, its foreign keys to `Meal`,
`LedgerParty`, and `Product`, its three foreign-key indexes, and its grams and
source-shape check constraints. Existing meal, product, and party rows need no
backfill, and deployed code that predates this feature remains compatible while
the empty table exists.

Use Cubby's normal interactive Drizzle `db:push` process only after coordinating
exclusive ownership of the production schema change. Cancel if Drizzle proposes
any rename, drop, unrelated index recreation, or array-default alteration. Do not
use `--force`.

After the push, read the production schema back and verify:

- `MealFoodEntry` exists with nullable `productId`, `grams`, `name`, `nutrients`,
  and `deletedAt` columns.
- The `mealId` and `ledgerPartyId` columns are required.
- Foreign keys target `Meal.id`, `LedgerParty.id`, and `Product.id`.
- The meal, eater, and product indexes exist.
- `MealFoodEntry_grams_check` and `MealFoodEntry_source_check` are present and
  validated.

Production DDL has not been applied by this implementation task.
