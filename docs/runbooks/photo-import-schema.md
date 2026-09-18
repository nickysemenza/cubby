# Photo import schema rollout

The manifest-driven importer is an additive rollout. Apply this expansion before
deploying code that writes import receipts. `AiAnalysis.entityType` is plain text,
so accepting `image` needs no database enum migration.

```sql
CREATE TABLE IF NOT EXISTS "PhotoImportReceipt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotencyKey" text NOT NULL,
  "requestHash" text NOT NULL,
  "receipt" jsonb NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "PhotoImportReceipt_idempotencyKey_key"
  ON "PhotoImportReceipt" ("idempotencyKey");
```

After applying the expansion, verify it rather than trusting the push summary:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'PhotoImportReceipt'
ORDER BY ordinal_position;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'PhotoImportReceipt';
```

Rollback is intentionally not part of the initial deploy. Old application code
ignores this table, and retaining receipts preserves retry safety across a rollback.
