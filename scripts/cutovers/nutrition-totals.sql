-- Run only during the coordinated nutrition cutover, with old readers and
-- recomputation writers quiesced. These values are derived; authored recipe,
-- preparation, and portion records are not changed. Include deleted recipes so
-- diagnostic reads cannot encounter the previous JSON contract.
BEGIN;
UPDATE "Recipe"
SET "totals" = NULL, "totalsComputedAt" = NULL;

SELECT count(*) AS remaining_cached_totals
FROM "Recipe"
WHERE "totals" IS NOT NULL OR "totalsComputedAt" IS NOT NULL;
COMMIT;
