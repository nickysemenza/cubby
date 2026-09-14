# Native photo library schema rollout

This feature is an additive Image-table rollout. The production expansion was
applied on 2026-09-13 before any code deployment. Read-back confirmed both
columns are nullable (`text` and `jsonb` respectively), and the lowercase hash
constraint was validated. The idempotent SQL used was:

```sql
ALTER TABLE "Image"
  ADD COLUMN IF NOT EXISTS "perceptualHash" text,
  ADD COLUMN IF NOT EXISTS "sourceFingerprint" jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Image_perceptualHash_format_check'
  ) THEN
    ALTER TABLE "Image"
      ADD CONSTRAINT "Image_perceptualHash_format_check"
      CHECK ("perceptualHash" IS NULL OR "perceptualHash" ~ '^[0-9a-f]{16}$')
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE "Image"
  VALIDATE CONSTRAINT "Image_perceptualHash_format_check";
```

No backfill is required for deploy compatibility. Existing rows remain valid;
the native hash index reports their null hashes in its repair list. After the
schema change, read the table definition back and confirm both columns are
nullable. That verification is complete for production; application code has
not yet been deployed. Do not use `drizzle-kit push --force`; the web database
has known unrelated index and array-default drift.
