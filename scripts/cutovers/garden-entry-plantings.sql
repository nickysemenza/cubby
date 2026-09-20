-- Run only during the coordinated Garden Entry planting cutover, after all
-- browser, API, MCP, native, queue, cron, and maintenance writers are
-- quiesced. This script is intentionally rerunnable. It never removes the
-- legacy GardenEntry.plantingId column. The verification block raises on any
-- mismatch, so run the file with a client that stops on SQL errors.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

DO $$
BEGIN
  IF to_regclass('public."GardenEntry"') IS NULL THEN
    RAISE EXCEPTION 'GardenEntry table is missing';
  END IF;

  IF to_regclass('public."GardenEntryPlanting"') IS NULL THEN
    RAISE EXCEPTION 'GardenEntryPlanting table is missing; apply the additive schema first';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'GardenEntry'
      AND column_name = 'plantingId'
  ) THEN
    RAISE EXCEPTION 'GardenEntry.plantingId is missing; this backfill must run before cleanup';
  END IF;
END $$;

LOCK TABLE "GardenEntry" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "GardenEntryPlanting" IN SHARE ROW EXCLUSIVE MODE;

WITH inserted AS (
  INSERT INTO "GardenEntryPlanting" (
    "id",
    "gardenEntryId",
    "plantingId",
    "createdAt",
    "updatedAt",
    "deletedAt"
  )
  SELECT
    gen_random_uuid(),
    garden_entry."id",
    garden_entry."plantingId",
    garden_entry."createdAt",
    garden_entry."updatedAt",
    garden_entry."deletedAt"
  FROM "GardenEntry" AS garden_entry
  WHERE garden_entry."plantingId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "GardenEntryPlanting" AS association
      WHERE association."gardenEntryId" = garden_entry."id"
        AND association."plantingId" = garden_entry."plantingId"
    )
  RETURNING 1
)
SELECT count(*) AS inserted_associations
FROM inserted;

DO $$
DECLARE
  legacy_pair_count bigint;
  covered_pair_count bigint;
  missing_pair_count bigint;
  duplicate_pair_count bigint;
  deletion_mismatch_count bigint;
  orphan_entry_count bigint;
  orphan_planting_count bigint;
BEGIN
  SELECT count(*)
  INTO legacy_pair_count
  FROM "GardenEntry"
  WHERE "plantingId" IS NOT NULL;

  SELECT count(*)
  INTO covered_pair_count
  FROM "GardenEntry" AS garden_entry
  WHERE garden_entry."plantingId" IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM "GardenEntryPlanting" AS association
      WHERE association."gardenEntryId" = garden_entry."id"
        AND association."plantingId" = garden_entry."plantingId"
    );

  SELECT count(*)
  INTO missing_pair_count
  FROM "GardenEntry" AS garden_entry
  WHERE garden_entry."plantingId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "GardenEntryPlanting" AS association
      WHERE association."gardenEntryId" = garden_entry."id"
        AND association."plantingId" = garden_entry."plantingId"
    );

  SELECT count(*)
  INTO duplicate_pair_count
  FROM (
    SELECT association."gardenEntryId", association."plantingId"
    FROM "GardenEntryPlanting" AS association
    GROUP BY association."gardenEntryId", association."plantingId"
    HAVING count(*) > 1
  ) AS duplicate_pairs;

  SELECT count(*)
  INTO deletion_mismatch_count
  FROM "GardenEntry" AS garden_entry
  JOIN "GardenEntryPlanting" AS association
    ON association."gardenEntryId" = garden_entry."id"
    AND association."plantingId" = garden_entry."plantingId"
  WHERE garden_entry."plantingId" IS NOT NULL
    AND association."deletedAt" IS DISTINCT FROM garden_entry."deletedAt";

  SELECT count(*)
  INTO orphan_entry_count
  FROM "GardenEntryPlanting" AS association
  LEFT JOIN "GardenEntry" AS garden_entry
    ON garden_entry."id" = association."gardenEntryId"
  WHERE garden_entry."id" IS NULL;

  SELECT count(*)
  INTO orphan_planting_count
  FROM "GardenEntryPlanting" AS association
  LEFT JOIN "Planting" AS planting
    ON planting."id" = association."plantingId"
  WHERE planting."id" IS NULL;

  RAISE NOTICE
    'Garden Entry planting backfill: legacy=%, covered=%, missing=%, duplicate_pairs=%, deletion_mismatches=%, orphan_entries=%, orphan_plantings=%',
    legacy_pair_count,
    covered_pair_count,
    missing_pair_count,
    duplicate_pair_count,
    deletion_mismatch_count,
    orphan_entry_count,
    orphan_planting_count;

  IF covered_pair_count <> legacy_pair_count
    OR missing_pair_count <> 0
    OR duplicate_pair_count <> 0
    OR deletion_mismatch_count <> 0
    OR orphan_entry_count <> 0
    OR orphan_planting_count <> 0
  THEN
    RAISE EXCEPTION 'Garden Entry planting backfill verification failed';
  END IF;
END $$;

COMMIT;
