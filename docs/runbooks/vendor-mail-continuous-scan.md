# Vendor Gmail scan checkpoint expansion

Apply this additive migration before deploying the continuous scan code. The
previous deployed worker ignores both new columns, and their defaults preserve
existing jobs. Confirm no other production schema migration is in flight.

```sql
BEGIN;

ALTER TABLE "VendorMailSearchJob"
  ADD COLUMN IF NOT EXISTS "searchTerms" text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS "pagesScanned" integer NOT NULL DEFAULT 0;

COMMIT;
```

Read back the columns and defaults before merging:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'VendorMailSearchJob'
  AND column_name IN ('searchTerms', 'pagesScanned')
ORDER BY column_name;
```

Older jobs keep empty `searchTerms`, so their historical query criteria cannot
be reconstructed. New jobs save the exact sender/domain terms at launch.
