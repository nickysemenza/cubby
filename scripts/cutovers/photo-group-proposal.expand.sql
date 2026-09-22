-- PhotoGroupProposal: an agent's proposed photo-inventory grouping, reviewed
-- and approved on the web run page before `commit_photo_group` writes it.
-- Additive and expand-only: run in Neon BEFORE deploying the commit that ships
-- `photoGroupProposal` in apps/web/src/server/db/schema.ts, so the product and
-- location merge/delete paths that repoint this table never meet a missing
-- relation. Equivalent to what `db:push` would create; written out so the
-- CHECK bodies are applied deliberately and can be read back below.
BEGIN;

CREATE TABLE IF NOT EXISTS "PhotoGroupProposal" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "runId" uuid NOT NULL,
  "groupKey" text NOT NULL,
  "state" text DEFAULT 'proposed' NOT NULL,
  "images" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "skip" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "productKind" text NOT NULL,
  "productId" uuid,
  "productCreate" jsonb,
  "inventoryLocationId" uuid,
  "inventory" jsonb,
  "evidence" text,
  "conflictProductIds" jsonb,
  "lastError" text,
  "committedAt" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  -- Drizzle's FK names, so a later `db:push` sees no drift.
  CONSTRAINT "PhotoGroupProposal_runId_ImportRun_id_fk"
    FOREIGN KEY ("runId") REFERENCES "ImportRun"("id"),
  CONSTRAINT "PhotoGroupProposal_productId_Product_id_fk"
    FOREIGN KEY ("productId") REFERENCES "Product"("id"),
  CONSTRAINT "PhotoGroupProposal_inventoryLocationId_Location_id_fk"
    FOREIGN KEY ("inventoryLocationId") REFERENCES "Location"("id"),
  CONSTRAINT "PhotoGroupProposal_state_check"
    CHECK ("state" IN ('proposed', 'committed', 'discarded')),
  CONSTRAINT "PhotoGroupProposal_product_kind_check"
    CHECK ("productKind" IN ('existing', 'create'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "PhotoGroupProposal_run_group_key"
  ON "PhotoGroupProposal" ("runId", "groupKey");
CREATE INDEX IF NOT EXISTS "PhotoGroupProposal_product_idx"
  ON "PhotoGroupProposal" ("productId");
CREATE INDEX IF NOT EXISTS "PhotoGroupProposal_location_idx"
  ON "PhotoGroupProposal" ("inventoryLocationId");

COMMIT;

-- Verify: two CHECKs, three FKs, three indexes plus the primary key.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = '"PhotoGroupProposal"'::regclass ORDER BY conname;
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'PhotoGroupProposal' ORDER BY indexname;
