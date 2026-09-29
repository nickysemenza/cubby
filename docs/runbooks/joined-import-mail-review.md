# Joined import mail review: schema expansion

The web Worker reads these columns and the decision table on every vendor mail
worklist request. Apply this additive SQL to production **before** merging the
PR that adds the worklist. Use one migration owner and ensure no other schema
change is running. The deployed Worker can continue using the expanded schema.

## Preflight

Read the live schema and compare it with the PR snapshot. Stop if an existing
object has a different definition; do not overwrite it. This SQL is the
historical expand step, already applied; new schema changes ship as committed
migrations.

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('VendorAccount', 'OrderMailEvent', 'OrderMailCandidateDecision')
ORDER BY table_name, ordinal_position;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'OrderMailCandidateDecision';
```

## Expand

Run as one transaction. Existing Vendor accounts remain eligible for browser
sync; the mail pipeline explicitly inserts new mail-only accounts with
`browserSyncEnabled = false`.

```sql
BEGIN;

ALTER TABLE "VendorAccount"
  ADD COLUMN IF NOT EXISTS "browserSyncEnabled" boolean NOT NULL DEFAULT true;

ALTER TABLE "OrderMailEvent"
  ADD COLUMN IF NOT EXISTS "supersededAt" timestamp;

CREATE TABLE IF NOT EXISTS "OrderMailCandidateDecision" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventId" uuid NOT NULL REFERENCES "OrderMailEvent"("id"),
  "purchaseId" uuid NOT NULL REFERENCES "Purchase"("id"),
  "decision" text NOT NULL,
  "evidenceChecksum" text NOT NULL,
  "decidedByUserId" text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "OrderMailCandidateDecision_decision_check"
    CHECK ("decision" IN ('linked', 'dismissed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderMailCandidateDecision_event_purchase_key"
  ON "OrderMailCandidateDecision" ("eventId", "purchaseId");
CREATE UNIQUE INDEX IF NOT EXISTS "OrderMailCandidateDecision_one_link_key"
  ON "OrderMailCandidateDecision" ("eventId")
  WHERE "decision" = 'linked';
CREATE INDEX IF NOT EXISTS "OrderMailCandidateDecision_purchase_idx"
  ON "OrderMailCandidateDecision" ("purchaseId");

COMMIT;
```

## Readback and deploy gate

Repeat the preflight queries. Confirm existing Vendor accounts have browser
sync enabled and the decision table starts empty. Confirm the partial unique
index predicate and the decision check explicitly; the readback below is the
only check. Keep auto-merge off until the SQL and readback are complete, then require
GitHub Actions on the exact final PR head.

```sql
SELECT count(*) AS disabled_existing_accounts
FROM "VendorAccount"
WHERE "browserSyncEnabled" IS NOT TRUE;

SELECT count(*) AS decision_rows FROM "OrderMailCandidateDecision";

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = '"OrderMailCandidateDecision"'::regclass;
```

The expected count of disabled existing accounts is zero immediately after
expansion. Once the new mail pipeline runs, mail-only accounts can make this
count nonzero.
