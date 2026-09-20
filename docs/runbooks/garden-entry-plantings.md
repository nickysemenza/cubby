# Garden Entry planting cutover

This cutover replaces the nullable `GardenEntry.plantingId` column with the
many-to-many `GardenEntryPlanting` table. It is a coordinated maintenance
operation: old and new Garden Entry writers are intentionally not compatible,
and `main` automatically deploys the web Worker after merge.

Keep one operator responsible for the database and deployment. Do not run
`db:push` for this cutover: it can combine the intended changes with unrelated
production drift and cannot safely order the expansion and cleanup.

## 1. Prepare and expand

1. Finish local validation and require GitHub Actions to pass on the exact PR
   head. Prepare the matching Apple build, but do not merge yet.
2. Confirm the target database and take a restorable database backup.
3. Inspect the current columns, constraints, indexes, and legacy-row count.
4. Apply only this additive schema while the old Worker is still deployed:

```sql
CREATE TABLE "GardenEntryPlanting" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "gardenEntryId" uuid NOT NULL
    REFERENCES "GardenEntry" ("id"),
  "plantingId" uuid NOT NULL
    REFERENCES "Planting" ("id"),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  "deletedAt" timestamp
);

CREATE UNIQUE INDEX "GardenEntryPlanting_gardenEntryId_plantingId_key"
  ON "GardenEntryPlanting" ("gardenEntryId", "plantingId")
  WHERE "deletedAt" IS NULL;

CREATE INDEX "GardenEntryPlanting_gardenEntryId_idx"
  ON "GardenEntryPlanting" ("gardenEntryId");

CREATE INDEX "GardenEntryPlanting_plantingId_idx"
  ON "GardenEntryPlanting" ("plantingId");
```

Read the table and index definitions back from PostgreSQL before proceeding.
The old Worker ignores this additive table.

## 2. Freeze and backfill

1. Hold household browser, HTTP API, MCP, and native traffic. Pause delivery
   on `cubby-background` and any scheduled or maintenance producer that can
   write application data.
2. Allow in-flight requests and jobs to finish. Keep the hold active until the
   new Worker and Apple client are verified.
3. Run the checked-in backfill with a SQL client configured to stop on error:

```sh
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  --file scripts/cutovers/garden-entry-plantings.sql
```

The script locks the source and destination tables, inserts only missing
legacy pairs, and aborts on missing pairs, duplicate pairs, deletion-state
drift, or orphaned foreign keys. Its final notice must report zero for every
problem count and equal `legacy` and `covered` counts.

Run the same command a second time. It must report
`inserted_associations = 0` with the same clean verification totals.

## 3. Deploy and verify

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

## 4. Remove the legacy column

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
traffic.

After the column is removed and real many-to-many writes begin, an old Worker
cannot represent the data. Recovery from that point means re-entering the
traffic hold, restoring the cutover backup, and redeploying its matching old
Worker and Apple client.
