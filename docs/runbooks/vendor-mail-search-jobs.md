# Vendor Gmail search jobs: schema expansion

Apply this additive SQL to production before merging the PR that reads
`OrderMail.classifiedChecksum` and `VendorMailSearchJob`. One migration owner
must confirm no other schema change is in flight. The currently deployed code
continues to work with these additions.

## Preflight

Confirm that `OrderMail` and `Run` exist and that neither new object has a
conflicting definition. Do not use `db:push --force`.

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('OrderMail', 'Run', 'VendorMailSearchJob')
ORDER BY table_name, ordinal_position;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'VendorMailSearchJob';
```

## Expand

```sql
BEGIN;

ALTER TABLE "OrderMail"
  ADD COLUMN IF NOT EXISTS "classifiedChecksum" text;

CREATE TABLE IF NOT EXISTS "VendorMailSearchJob" (
  "runId" uuid PRIMARY KEY REFERENCES "Run"("id"),
  "after" text NOT NULL,
  "pageToken" text,
  "status" text NOT NULL DEFAULT 'queued',
  "searched" integer NOT NULL DEFAULT 0,
  "skipped" integer NOT NULL DEFAULT 0,
  "reviewable" integer NOT NULL DEFAULT 0,
  "nextPageToken" text,
  "error" text,
  "startedAt" timestamp,
  "finishedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

COMMIT;
```

## Readback and deploy gate

Repeat the preflight queries. Confirm `classifiedChecksum` is nullable and the
job table's Run foreign key exists. The new table starts empty. Keep auto-merge
off until this readback and exact PR-head GitHub Actions pass.

```sql
SELECT count(*) AS search_jobs FROM "VendorMailSearchJob";

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = '"VendorMailSearchJob"'::regclass;
```
