-- ImportRun becomes the `purchaseImportRun` entity: a RUN- shortcode replaces
-- the PIR- public id. Run in Neon BEFORE deploying the commit that ships
-- `packages/schemas/src/entity-definitions/23-purchaseImportRun.entity.ts`.
-- Everything here is one transaction; `db:push` afterwards should report only
-- the usual gin_trgm_ops / array-default drift.
--
-- No dual-accept: an active run's Flue instance and browser commands name the
-- run by its PIR- code, which stops resolving at deploy. Every non-terminal run
-- is failed here and its account's pause is cleared so the next sync starts a
-- fresh run.
BEGIN;

-- 1. Hard-reset in-flight runs (cancel the one still running first if you
--    want its findings preserved; this marks it failed either way).
UPDATE "ImportRun"
SET status = 'failed',
    "failureCode" = 'identity_cutover',
    "endedAt" = now(),
    "updatedAt" = now()
WHERE status IN ('running', 'paused_auth', 'paused_offline', 'paused_approval');

UPDATE "VendorAccount"
SET status = 'active', "updatedAt" = now()
WHERE status IN ('paused_auth', 'paused_offline');

-- 2. Expand: shortcode + never-set deletedAt.
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS shortcode text;
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "deletedAt" timestamp;

-- 3. Backfill RUN-XXXX from the shortcode alphabet (no 0/O/1/I/L), unique.
DO $$
DECLARE
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  r record;
  candidate text;
BEGIN
  FOR r IN SELECT id FROM "ImportRun" WHERE shortcode IS NULL LOOP
    LOOP
      candidate := 'RUN-' ||
        substr(alphabet, 1 + floor(random() * 31)::int, 1) ||
        substr(alphabet, 1 + floor(random() * 31)::int, 1) ||
        substr(alphabet, 1 + floor(random() * 31)::int, 1) ||
        substr(alphabet, 1 + floor(random() * 31)::int, 1);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "ImportRun" WHERE shortcode = candidate);
    END LOOP;
    UPDATE "ImportRun" SET shortcode = candidate WHERE id = r.id;
  END LOOP;
END $$;

-- 4. Contract: the column is required and unique; the PIR- id goes away.
ALTER TABLE "ImportRun" ALTER COLUMN shortcode SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ImportRun_shortcode_unique" ON "ImportRun" (shortcode);
DROP INDEX IF EXISTS "ImportRun_publicId_unique";
ALTER TABLE "ImportRun" DROP COLUMN IF EXISTS "publicId";

-- Verification: both must return zero rows.
SELECT id FROM "ImportRun" WHERE shortcode !~ '^RUN-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$';
SELECT id FROM "ImportRun" WHERE status IN ('running', 'paused_auth', 'paused_offline', 'paused_approval');

COMMIT;
