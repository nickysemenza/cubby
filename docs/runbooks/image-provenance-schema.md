# Image provenance and devices schema rollout

Delivered in parts, one per PR in `docs/plans/image-provenance-and-devices.md`.
Each part's SQL is additive (new table or nullable columns only) and is
expand-before-deploy: apply the schema change, confirm it read back correctly,
THEN deploy the code that reads/writes it. No part here requires a backfill
for deploy compatibility.

## Part 1 — `Device`

New table, no existing rows to migrate. Idempotent SQL:

```sql
CREATE TABLE IF NOT EXISTS "Device" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shortcode" text NOT NULL,
  "installationId" text NOT NULL,
  "name" text NOT NULL,
  "platform" text NOT NULL,
  "appVersion" text,
  "osVersion" text,
  "lastSeenAt" timestamp,
  "automaticWork" boolean NOT NULL DEFAULT true,
  "remotePaused" boolean NOT NULL DEFAULT false,
  "ledgerPartyId" uuid REFERENCES "LedgerParty"("id"),
  "productId" uuid REFERENCES "Product"("id"),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  "deletedAt" timestamp
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Device_platform_check'
  ) THEN
    ALTER TABLE "Device"
      ADD CONSTRAINT "Device_platform_check"
      CHECK ("platform" IN ('ios', 'macos'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "Device_shortcode_unique" ON "Device" ("shortcode");

CREATE UNIQUE INDEX IF NOT EXISTS "Device_installationId_key"
  ON "Device" ("installationId")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Device_ledgerPartyId_idx" ON "Device" ("ledgerPartyId");
CREATE INDEX IF NOT EXISTS "Device_productId_idx" ON "Device" ("productId");
```

Expand-before-deploy order:

1. Apply the SQL above against production. `CREATE TABLE IF NOT EXISTS` and
   `CREATE INDEX IF NOT EXISTS` make every statement safe to re-run.
2. Read the table definition back (`\d "Device"` in `psql`, or the equivalent
   `information_schema.columns` query) and confirm: every column's
   nullability matches the list above, the `Device_platform_check` constraint
   exists and is valid, `Device_installationId_key` is a unique index scoped
   by `"deletedAt" IS NULL` (not a plain unique constraint — a soft-deleted
   device must not block a fresh install claiming the same `installationId`),
   and both FK columns reference live tables.
3. Deploy the code that reads/writes `Device` (this PR): the companion durable
   object's hello handler, the generic entity CRUD/MCP surface, and the web
   list/detail pages. All new companion wire fields (`participation` on hello,
   the `helloAck` server message) are exercised by every hello after this
   deploy — there is no older-client compatibility branch to preserve for this
   field, so this deploy and the native build that sends `participation` must
   land together.

No rollback concern beyond the usual: dropping the table is safe as long as
no deployed code still references it (`Device` carries no incoming edges from
any other table in this PR — see `entity-edges.ts`'s empty `device: edges({})`
block — so there is nothing else to clean up first).

## Later parts

`ImageSighting` (PR 3a) and the `Image` provenance columns (also PR 3a) will
get their own part here when that PR lands, following the same
expand → deploy → (dry-run classify → apply) shape the plan's Delivery table
describes.
