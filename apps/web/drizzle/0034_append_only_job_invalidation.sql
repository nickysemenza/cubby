-- Serialize predecessor source captures and execution observation before reading
-- either side. Old revision writers fail atomically after this direct cutover.
LOCK TABLE "Job", "JobInvalidation", "JobInvalidationCapture" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
  retained_count bigint;
  backfilled_count bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM "JobInvalidation" m LEFT JOIN "Job" j ON j.key = m.key WHERE j.id IS NULL) THEN
    RAISE EXCEPTION 'Invalidation policy without owning Job; preserve and investigate before cutover';
  END IF;
  SELECT count(*) INTO retained_count FROM "JobInvalidationCapture";
  ALTER TABLE "JobInvalidationCapture" DROP CONSTRAINT "JobInvalidationCapture_key_revision_pk";
  ALTER TABLE "JobInvalidationCapture" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "JobInvalidationCapture" ADD COLUMN "observed" boolean DEFAULT false NOT NULL;
  UPDATE "JobInvalidationCapture" c SET observed = c.revision <= coalesce(j."observedRevision", 0)
    FROM "Job" j WHERE j.key = c.key;
  -- Retain a pending marker even if its old capture log was absent/pruned.
  INSERT INTO "JobInvalidationCapture" (key, revision, "capturedAt")
    SELECT m.key, m.revision, m."updatedAt" FROM "JobInvalidation" m JOIN "Job" j ON j.key = m.key
    WHERE m.revision > coalesce(j."observedRevision", 0)
      AND NOT EXISTS (SELECT 1 FROM "JobInvalidationCapture" c WHERE c.key = m.key AND NOT c.observed);
  GET DIAGNOSTICS backfilled_count = ROW_COUNT;
  IF (SELECT count(*) FROM "JobInvalidationCapture") <> retained_count + backfilled_count THEN
    RAISE EXCEPTION 'Invalidation capture preservation count mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM "JobInvalidationCapture" c JOIN "Job" j ON j.key = c.key
      WHERE c.observed IS DISTINCT FROM (c.revision <= coalesce(j."observedRevision", 0))) THEN
    RAISE EXCEPTION 'Invalidation observation mapping mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM "JobInvalidation" m JOIN "Job" j ON j.key = m.key
      WHERE m.revision > coalesce(j."observedRevision", 0)
      AND NOT EXISTS (SELECT 1 FROM "JobInvalidationCapture" c WHERE c.key = m.key AND NOT c.observed)) THEN
    RAISE EXCEPTION 'Pending invalidation has no retained capture';
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX "JobInvalidationCapture_pending_idx" ON "JobInvalidationCapture" USING btree ("key","capturedAt") WHERE NOT "JobInvalidationCapture"."observed";--> statement-breakpoint
ALTER TABLE "Job" DROP COLUMN "observedRevision";--> statement-breakpoint
ALTER TABLE "JobInvalidation" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "JobInvalidation" DROP COLUMN "updatedAt";--> statement-breakpoint
ALTER TABLE "JobInvalidationCapture" DROP COLUMN "revision";
