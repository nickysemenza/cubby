# Meal amount schema rollout

Meal food entries and recipe portions are moving from gram-only storage to the
canonical JSONB scalar `{ "value": number, "unit": string }`. The application
change is an expand-migrate-contract rollout. This task prepares the schema and
SQL only; it does not apply production DDL.

## 1. Expand before deploying application code

Coordinate exclusive ownership of the production schema change. Apply the
columns, index, foreign key, and replacement checks while the deployed version
still writes `grams`. The new columns and both legacy `grams` columns remain
nullable so old rows and old writers satisfy the expanded schema.

`db:push` does not update CHECK constraints. Apply and validate these changes
deliberately; cancel any unrelated rename, drop, trigram-index recreation, or
array-default alteration.

```sql
BEGIN;

ALTER TABLE "MealFoodEntry"
  ADD COLUMN IF NOT EXISTS "ingredientId" uuid,
  ADD COLUMN IF NOT EXISTS "amount" jsonb;

ALTER TABLE "MealRecipePortion"
  ADD COLUMN IF NOT EXISTS "amount" jsonb,
  ALTER COLUMN "grams" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'MealFoodEntry_ingredientId_Ingredient_id_fk'
  ) THEN
    ALTER TABLE "MealFoodEntry"
      ADD CONSTRAINT "MealFoodEntry_ingredientId_Ingredient_id_fk"
      FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "MealFoodEntry_ingredientId_idx"
  ON "MealFoodEntry" ("ingredientId");

ALTER TABLE "MealFoodEntry"
  DROP CONSTRAINT IF EXISTS "MealFoodEntry_grams_check",
  DROP CONSTRAINT IF EXISTS "MealFoodEntry_amount_check",
  DROP CONSTRAINT IF EXISTS "MealFoodEntry_amount_compatibility_check",
  DROP CONSTRAINT IF EXISTS "MealFoodEntry_source_check",
  ADD CONSTRAINT "MealFoodEntry_grams_check"
    CHECK ("grams" IS NULL OR ("grams" > 0 AND "grams" < 'Infinity'::float8)) NOT VALID,
  ADD CONSTRAINT "MealFoodEntry_amount_check" CHECK (
    "amount" IS NULL OR COALESCE((
      jsonb_typeof("amount") = 'object'
      AND "amount" ? 'value'
      AND "amount" ? 'unit'
      AND "amount" - 'value' - 'unit' = '{}'::jsonb
      AND CASE
        WHEN jsonb_typeof("amount"->'value') = 'number' THEN
          ("amount"->>'value')::numeric > 0
          AND ("amount"->>'value')::numeric < 'Infinity'::numeric
        ELSE false
      END
      AND jsonb_typeof("amount"->'unit') = 'string'
      AND length(trim("amount"->>'unit')) > 0
      AND "amount"->>'unit' = trim("amount"->>'unit')
    ), false)
  ) NOT VALID,
  ADD CONSTRAINT "MealFoodEntry_amount_compatibility_check"
    CHECK ("amount" IS NULL OR "grams" IS NULL) NOT VALID,
  ADD CONSTRAINT "MealFoodEntry_source_check" CHECK (
    ("sourceKind" = 'ingredient'
      AND "ingredientId" IS NOT NULL AND "productId" IS NULL
      AND ("amount" IS NOT NULL OR "grams" IS NOT NULL)
      AND "name" IS NULL AND "nutrients" IS NULL)
    OR ("sourceKind" = 'product'
      AND "ingredientId" IS NULL AND "productId" IS NOT NULL
      AND ("amount" IS NOT NULL OR "grams" IS NOT NULL)
      AND "name" IS NULL AND "nutrients" IS NULL)
    OR ("sourceKind" = 'manual'
      AND "ingredientId" IS NULL AND "productId" IS NULL
      AND "name" IS NOT NULL AND length(trim("name")) > 0
      AND "nutrients" IS NOT NULL
      AND jsonb_typeof("nutrients") = 'object'
      AND "nutrients" <> '{}'::jsonb)
  ) NOT VALID;

ALTER TABLE "MealRecipePortion"
  DROP CONSTRAINT IF EXISTS "MealRecipePortion_grams_check",
  DROP CONSTRAINT IF EXISTS "MealRecipePortion_amount_check",
  DROP CONSTRAINT IF EXISTS "MealRecipePortion_amount_source_check",
  ADD CONSTRAINT "MealRecipePortion_grams_check"
    CHECK ("grams" IS NULL OR "grams" > 0) NOT VALID,
  ADD CONSTRAINT "MealRecipePortion_amount_check" CHECK (
    "amount" IS NULL OR COALESCE((
      jsonb_typeof("amount") = 'object'
      AND "amount" ? 'value'
      AND "amount" ? 'unit'
      AND "amount" - 'value' - 'unit' = '{}'::jsonb
      AND CASE
        WHEN jsonb_typeof("amount"->'value') = 'number' THEN
          ("amount"->>'value')::numeric > 0
          AND ("amount"->>'value')::numeric < 'Infinity'::numeric
        ELSE false
      END
      AND jsonb_typeof("amount"->'unit') = 'string'
      AND length(trim("amount"->>'unit')) > 0
      AND "amount"->>'unit' = trim("amount"->>'unit')
    ), false)
  ) NOT VALID,
  ADD CONSTRAINT "MealRecipePortion_amount_source_check"
    CHECK (("amount" IS NULL) <> ("grams" IS NULL)) NOT VALID;

COMMIT;

ALTER TABLE "MealFoodEntry"
  VALIDATE CONSTRAINT "MealFoodEntry_ingredientId_Ingredient_id_fk";
ALTER TABLE "MealFoodEntry"
  VALIDATE CONSTRAINT "MealFoodEntry_grams_check",
  VALIDATE CONSTRAINT "MealFoodEntry_amount_check",
  VALIDATE CONSTRAINT "MealFoodEntry_amount_compatibility_check",
  VALIDATE CONSTRAINT "MealFoodEntry_source_check";
ALTER TABLE "MealRecipePortion"
  VALIDATE CONSTRAINT "MealRecipePortion_grams_check",
  VALIDATE CONSTRAINT "MealRecipePortion_amount_check",
  VALIDATE CONSTRAINT "MealRecipePortion_amount_source_check";
```

Read `pg_constraint`, `pg_indexes`, and `information_schema.columns` back after
the expansion. Confirm the new columns are nullable, the ingredient FK/index
exist, and every named check is validated.

## 2. Deploy dual-read application code, then backfill

The expanded application writes `amount` and `grams = NULL`. Reads prefer
`amount` and interpret a remaining legacy `grams` value as the same value in
unit `g`. Wait until old writers have drained, then run the idempotent backfill:

```sql
BEGIN;

UPDATE "MealFoodEntry"
SET "amount" = jsonb_build_object('value', "grams", 'unit', 'g'),
    "grams" = NULL
WHERE "amount" IS NULL AND "grams" IS NOT NULL;

UPDATE "MealRecipePortion"
SET "amount" = jsonb_build_object('value', "grams", 'unit', 'g'),
    "grams" = NULL
WHERE "amount" IS NULL AND "grams" IS NOT NULL;

COMMIT;
```

Verify migration completeness before preparing cleanup:

```sql
SELECT count(*) AS legacy_food_entries
FROM "MealFoodEntry" WHERE "grams" IS NOT NULL;

SELECT count(*) AS missing_required_food_amounts
FROM "MealFoodEntry"
WHERE "sourceKind" IN ('ingredient', 'product') AND "amount" IS NULL;

SELECT count(*) AS legacy_recipe_portions
FROM "MealRecipePortion" WHERE "grams" IS NOT NULL;

SELECT count(*) AS missing_recipe_portion_amounts
FROM "MealRecipePortion" WHERE "amount" IS NULL;
```

All four counts must be zero. A nonzero count means an old writer remains or a
row needs reconciliation; rerun the idempotent backfill only after identifying
which case applies.

## 3. Later cleanup

Cleanup is a separate deployment. First remove both `grams` declarations and
all legacy fallbacks from application code, deploy that build, and wait for the
previous build to drain. Only then apply the contract DDL:

```sql
BEGIN;

ALTER TABLE "MealFoodEntry"
  DROP CONSTRAINT "MealFoodEntry_grams_check",
  DROP CONSTRAINT "MealFoodEntry_amount_compatibility_check",
  DROP CONSTRAINT "MealFoodEntry_source_check",
  DROP COLUMN "grams",
  ADD CONSTRAINT "MealFoodEntry_source_check" CHECK (
    ("sourceKind" = 'ingredient'
      AND "ingredientId" IS NOT NULL AND "productId" IS NULL
      AND "amount" IS NOT NULL
      AND "name" IS NULL AND "nutrients" IS NULL)
    OR ("sourceKind" = 'product'
      AND "ingredientId" IS NULL AND "productId" IS NOT NULL
      AND "amount" IS NOT NULL
      AND "name" IS NULL AND "nutrients" IS NULL)
    OR ("sourceKind" = 'manual'
      AND "ingredientId" IS NULL AND "productId" IS NULL
      AND "name" IS NOT NULL AND length(trim("name")) > 0
      AND "nutrients" IS NOT NULL
      AND jsonb_typeof("nutrients") = 'object'
      AND "nutrients" <> '{}'::jsonb)
  ) NOT VALID;

ALTER TABLE "MealRecipePortion"
  DROP CONSTRAINT "MealRecipePortion_grams_check",
  DROP CONSTRAINT "MealRecipePortion_amount_source_check",
  DROP COLUMN "grams",
  ALTER COLUMN "amount" SET NOT NULL;

COMMIT;

ALTER TABLE "MealFoodEntry"
  VALIDATE CONSTRAINT "MealFoodEntry_source_check";
```

Read the schema back once more. Confirm neither table has `grams`, every recipe
portion has an `amount`, and manual food entries remain the only rows allowed to
omit an amount.
