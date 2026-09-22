-- ProductMatchCandidate: the durable half of the product match queue (agent
-- proposals with evidence, and dismissals of any pair). Additive and
-- expand-only: run in Neon BEFORE deploying the commit that ships
-- `productMatchCandidate` in apps/web/src/server/db/schema.ts, so the product
-- delete/merge paths that clean this table never meet a missing relation.
-- Equivalent to what `db:push` would create; written out so the CHECK bodies
-- are applied deliberately and can be read back below.
BEGIN;

CREATE TABLE IF NOT EXISTS "ProductMatchCandidate" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "productAId" uuid NOT NULL,
  "productBId" uuid NOT NULL,
  "source" text NOT NULL,
  "state" text NOT NULL,
  "evidence" text,
  "sourceUrls" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  -- Drizzle's FK names, so a later `db:push` sees no drift.
  CONSTRAINT "ProductMatchCandidate_productAId_Product_id_fk"
    FOREIGN KEY ("productAId") REFERENCES "Product"("id"),
  CONSTRAINT "ProductMatchCandidate_productBId_Product_id_fk"
    FOREIGN KEY ("productBId") REFERENCES "Product"("id"),
  CONSTRAINT "ProductMatchCandidate_canonical_pair_check"
    CHECK ("productAId" < "productBId"),
  CONSTRAINT "ProductMatchCandidate_source_check"
    CHECK ("source" IN ('agent', 'detector')),
  CONSTRAINT "ProductMatchCandidate_state_check"
    CHECK ("state" IN ('open', 'dismissed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductMatchCandidate_pair_key"
  ON "ProductMatchCandidate" ("productAId", "productBId");
CREATE INDEX IF NOT EXISTS "ProductMatchCandidate_productB_idx"
  ON "ProductMatchCandidate" ("productBId");

COMMIT;

-- Verify: three CHECKs, two FKs, two indexes.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = '"ProductMatchCandidate"'::regclass ORDER BY conname;
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'ProductMatchCandidate' ORDER BY indexname;
