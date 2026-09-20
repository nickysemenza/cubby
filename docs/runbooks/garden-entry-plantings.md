# Garden Entry planting cutover

This cutover replaces the nullable `GardenEntry.plantingId` column with the
many-to-many `GardenEntryPlanting` table. It is a coordinated maintenance
operation: old and new Garden Entry writers are intentionally not compatible,
and `main` automatically deploys the web Worker after merge.

The additive table and legacy association backfill have been applied and
verified in production. The one-shot backfill SQL and its script-specific test
were removed after use. Keep one operator responsible for the remaining
deployment and cleanup, and do not run `db:push` until the legacy column has
been removed: it cannot safely order the remaining deploy-before-drop boundary.

## 1. Deploy and verify

1. Merge the exact verified PR head. Do not release the traffic hold.
2. Wait for the normal `main` deployment and confirm that the production web
   Worker reports the merged source commit. A gradual split between old and new
   Worker versions is unsupported.
3. Exercise read-only Garden Entry list, detail, Planting journal, membership
   filter, and search requests. Exercise create/update/delete only in a
   transaction that is rolled back or against an explicitly disposable
   fixture, so the legacy column remains a valid rollback source.
4. Install the matching Apple build on every client and verify Garden Entry
   create and edit payloads use `plantingIds`.

If verification fails before cleanup, redeploy the previous Worker. The
legacy column remains unchanged and authoritative; the additive association
table can remain in place while the failure is investigated.

## 2. Remove the legacy column

After the new Worker and Apple clients pass verification, run this separately
while the traffic hold remains active:

```sql
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

LOCK TABLE "GardenEntry" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  missing_pair_count bigint;
BEGIN
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

  IF missing_pair_count <> 0 THEN
    RAISE EXCEPTION
      'GardenEntry.plantingId cleanup refused: % legacy pairs are missing',
      missing_pair_count;
  END IF;
END $$;

ALTER TABLE "GardenEntry" DROP COLUMN "plantingId";

COMMIT;
```

Read back the final Garden Entry and association table columns, constraints,
and indexes. Rerun the application integrity detector and the representative
Garden Entry/Planting flows, then resume background delivery and household
traffic. Production then matches the checked-in schema, so later `db:push`
runs can use the normal inspected, non-`--force` workflow without needing
special handling for this cutover.

After the column is removed and real many-to-many writes begin, an old Worker
cannot represent the data. Recovery from that point means re-entering the
traffic hold, restoring the cutover backup, and redeploying its matching old
Worker and Apple client.
