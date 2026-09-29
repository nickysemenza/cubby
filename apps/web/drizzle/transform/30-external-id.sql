-- External identifiers: one `EntityExternalId` table and a real
-- `ExternalSource` registry replace ProductExternalId, the
-- FinancialTransaction.sourceRefs jsonb, the Expense/Task/Project Notion page
-- ids, the Project Notion URL and Drive folder URL, and a Notion recipe's
-- SourceData. The Recipe source columns split at the same time (Notion page ids
-- move here). Plain DDL and backfills, no BEGIN/COMMIT; names match what
-- Drizzle emits for apps/web/src/server/db/schema.ts.

-- ---------------------------------------------------------------------------
-- Snapshot what must survive: per-source identifier counts, and the Purchase
-- settlement status histogram with the `settlement_reference` gap, computed
-- with the pre-migration (jsonb) evidence rule.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE "_xid_pre" ON COMMIT DROP AS
SELECT 'product' AS "what", count(*) AS "rows", count(*) FILTER (WHERE "deletedAt" IS NULL) AS "live"
  FROM "ProductExternalId"
UNION ALL
SELECT 'settlement_ref', count(*), count(*) FILTER (WHERE t."deletedAt" IS NULL)
  FROM "FinancialTransaction" t CROSS JOIN LATERAL jsonb_array_elements(t."sourceRefs")
UNION ALL
SELECT 'page:expense', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL)
  FROM "Expense" WHERE "notionPageId" IS NOT NULL
UNION ALL
SELECT 'page:task', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL)
  FROM "Task" WHERE "notionPageId" IS NOT NULL
UNION ALL
SELECT 'page:project', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL)
  FROM "Project" WHERE "notionPageId" IS NOT NULL
UNION ALL
SELECT 'page:recipe', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL)
  FROM "Recipe" WHERE "SourceType" = 'Notion'
UNION ALL
SELECT 'folder:project', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL)
  FROM "Project" WHERE "googleDriveFolderUrl" IS NOT NULL;
--> statement-breakpoint

CREATE TEMP TABLE "_xid_pre_settlement" ON COMMIT DROP AS
WITH agg AS (
  SELECT a."purchaseId",
    count(DISTINCT a."transactionId") AS "txn",
    count(DISTINCT a."transactionId") FILTER (WHERE ft."status" IN ('expected', 'pending')) AS "outstanding",
    COALESCE(sum(a."amount") FILTER (WHERE ft."status" = 'posted'), 0)::double precision AS "posted",
    COALESCE(sum(a."amount"), 0)::double precision AS "projected"
  FROM "FinancialTransactionAllocation" a
  JOIN "FinancialTransaction" ft ON ft."id" = a."transactionId"
  WHERE a."deletedAt" IS NULL AND ft."deletedAt" IS NULL
    AND ft."kind" IN ('purchase', 'refund', 'adjustment', 'income')
    AND ft."status" <> 'void'
  GROUP BY 1
), purchase AS (
  SELECT p."id",
    (SELECT COALESCE(sum(e."cost"), 0)::double precision FROM "Expense" e
      WHERE e."purchaseId" = p."id" AND e."deletedAt" IS NULL AND e."future" = false) AS "expense",
    (SELECT count(*) FROM "Expense" e
      WHERE e."purchaseId" = p."id" AND e."cost" IS NULL AND e."deletedAt" IS NULL AND e."future" = false) AS "unpriced",
    NOT EXISTS (
      SELECT 1 FROM "FinancialTransactionAllocation" sr_a
      JOIN "FinancialTransaction" sr_ft ON sr_ft."id" = sr_a."transactionId" AND sr_ft."deletedAt" IS NULL
      JOIN "FinancialAccount" sr_fa ON sr_fa."id" = sr_ft."accountId" AND sr_fa."deletedAt" IS NULL
      WHERE sr_a."purchaseId" = p."id" AND sr_a."deletedAt" IS NULL
        AND sr_ft."status" = 'posted'
        AND sr_ft."kind" IN ('purchase', 'refund', 'adjustment', 'income')
        AND (jsonb_array_length(sr_ft."sourceRefs") > 0 OR sr_fa."identity"->>'kind' = 'cash')
    ) AS "gap"
  FROM "Purchase" p WHERE p."deletedAt" IS NULL
)
SELECT
  CASE
    WHEN NOT (purchase."unpriced" = 0 AND COALESCE(agg."txn", 0) > 0) THEN 'unknown'
    WHEN agg."outstanding" > 0 AND floor(agg."projected" * 100 + 0.5) = floor(purchase."expense" * 100 + 0.5) THEN 'pending'
    WHEN agg."outstanding" = 0 AND floor(agg."posted" * 100 + 0.5) = floor(purchase."expense" * 100 + 0.5) THEN 'match'
    ELSE 'mismatch'
  END AS "status",
  purchase."gap",
  count(*) AS "purchases"
FROM purchase LEFT JOIN agg ON agg."purchaseId" = purchase."id"
GROUP BY 1, 2;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Guard the shapes the backfill relies on.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad bigint;
BEGIN
  -- A cookbook recipe's SourceData is its cookbook's name; dropping it loses nothing.
  SELECT count(*) INTO bad FROM "Recipe" r JOIN "Cookbook" c ON c."id" = r."cookbookId"
  WHERE r."SourceType" = 'Book' AND r."SourceData" IS DISTINCT FROM c."name";
  IF bad > 0 THEN
    RAISE EXCEPTION 'external-id: % cookbook recipe(s) carry SourceData other than their cookbook name', bad;
  END IF;
  -- Website SourceData is the page URL; Notion SourceData is the page id.
  SELECT count(*) INTO bad FROM "Recipe"
  WHERE ("SourceType" = 'Website' AND ("SourceData" IS NULL OR "SourceData" !~ '^https?://'))
     OR ("SourceType" = 'Notion' AND ("SourceData" IS NULL OR "SourceData" = ''))
     OR ("SourceType" = 'Other' AND "SourceData" IS NOT NULL);
  IF bad > 0 THEN
    RAISE EXCEPTION 'external-id: % recipe(s) have an unexpected SourceData shape', bad;
  END IF;
  -- Every settlement reference is a {source, externalId} pair.
  SELECT count(*) INTO bad
  FROM "FinancialTransaction" t CROSS JOIN LATERAL jsonb_array_elements(t."sourceRefs") r
  WHERE coalesce(r->>'source', '') = '' OR coalesce(r->>'externalId', '') = '';
  IF bad > 0 THEN
    RAISE EXCEPTION 'external-id: % settlement reference(s) lack a source or externalId', bad;
  END IF;
  -- Every Drive folder URL names its folder id.
  SELECT count(*) INTO bad FROM "Project"
  WHERE "googleDriveFolderUrl" IS NOT NULL
    AND substring("googleDriveFolderUrl" from 'folders/([A-Za-z0-9_-]+)') IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION 'external-id: % Drive folder URL(s) have no folder id', bad;
  END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- One spelling per source: `authorize.net` is not a slug.
-- ---------------------------------------------------------------------------
UPDATE "FinancialTransaction" t
SET "sourceRefs" = (
  SELECT jsonb_agg(
    CASE WHEN r->>'source' = 'authorize.net'
      THEN jsonb_set(r, '{source}', '"authorize-net"') ELSE r END
    ORDER BY ord)
  FROM jsonb_array_elements(t."sourceRefs") WITH ORDINALITY AS e(r, ord)
)
WHERE t."sourceRefs" @> '[{"source": "authorize.net"}]';
--> statement-breakpoint
UPDATE "ProductExternalId" SET "source" = 'authorize-net' WHERE "source" = 'authorize.net';
--> statement-breakpoint
UPDATE "StatementImport" SET "source" = 'authorize-net' WHERE "source" = 'authorize.net';
--> statement-breakpoint
UPDATE "StatementRow" SET "source" = 'authorize-net' WHERE "source" = 'authorize.net';
--> statement-breakpoint
UPDATE "LedgerSourceClaim" SET "source" = 'authorize-net' WHERE "source" = 'authorize.net';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ExternalSource
-- ---------------------------------------------------------------------------
CREATE TABLE "ExternalSource" (
  "slug" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "vendorId" uuid,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ExternalSource_slug_check" CHECK ("ExternalSource"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "ExternalSource" ADD CONSTRAINT "ExternalSource_vendorId_Vendor_id_fk"
  FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "ExternalSource" ("slug", "label", "vendorId")
SELECT s."slug", s."slug",
  (SELECT (array_agg(v."id" ORDER BY v."id"))[1] FROM "Vendor" v
    WHERE lower(v."name") = s."slug" AND v."deletedAt" IS NULL)
FROM (
  SELECT "source" AS "slug" FROM "ProductExternalId"
  UNION SELECT r->>'source' FROM "FinancialTransaction" t CROSS JOIN LATERAL jsonb_array_elements(t."sourceRefs") r
  UNION SELECT "source" FROM "StatementImport"
  UNION SELECT "source" FROM "StatementRow"
  UNION SELECT "source" FROM "LedgerSourceClaim"
  UNION SELECT 'notion'
  UNION SELECT 'google-drive'
) s;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- EntityExternalId
-- ---------------------------------------------------------------------------
CREATE TABLE "EntityExternalId" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entityId" uuid NOT NULL,
  "entityKind" text NOT NULL,
  "source" text NOT NULL,
  "kind" text NOT NULL,
  "externalId" text NOT NULL,
  "url" text,
  "isPrimary" boolean,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  "deletedAt" timestamp,
  CONSTRAINT "EntityExternalId_kind_check" CHECK (("entityKind", "kind") IN (
    ('product', 'asin'), ('product', 'retailer_sku'), ('product', 'internet_number'),
    ('product', 'item_number'), ('product', 'catalog_number'), ('product', 'gtin_14'),
    ('product', 'legacy_unspecified'), ('financialTransaction', 'settlement_ref'),
    ('expense', 'page'), ('task', 'page'), ('project', 'page'), ('recipe', 'page'),
    ('project', 'folder'))),
  CONSTRAINT "EntityExternalId_primary_check" CHECK (CASE WHEN "kind" IN (
    'asin', 'retailer_sku', 'internet_number', 'item_number', 'catalog_number',
    'gtin_14', 'legacy_unspecified', 'page', 'folder')
    THEN "isPrimary" IS NOT NULL ELSE "isPrimary" IS NULL END),
  CONSTRAINT "EntityExternalId_gtin_check" CHECK ("EntityExternalId"."kind" <> 'gtin_14' OR "EntityExternalId"."externalId" ~ '^[0-9]{14}$')
);
--> statement-breakpoint

INSERT INTO "EntityExternalId" ("id", "entityId", "entityKind", "source", "kind", "externalId", "url", "isPrimary", "createdAt", "updatedAt", "deletedAt")
SELECT "id", "productId", 'product', "source", "kind", "externalId", "url", "isPrimary", "createdAt", "updatedAt", "deletedAt"
FROM "ProductExternalId";
--> statement-breakpoint
-- Settlement references are slotless (a charge can name several orders) and
-- live and die with their transaction.
INSERT INTO "EntityExternalId" ("entityId", "entityKind", "source", "kind", "externalId", "url", "isPrimary", "createdAt", "updatedAt", "deletedAt")
SELECT t."id", 'financialTransaction', r->>'source', 'settlement_ref', r->>'externalId', NULL::text, NULL::boolean, t."createdAt", t."updatedAt", t."deletedAt"
FROM "FinancialTransaction" t CROSS JOIN LATERAL jsonb_array_elements(t."sourceRefs") r;
--> statement-breakpoint
INSERT INTO "EntityExternalId" ("entityId", "entityKind", "source", "kind", "externalId", "url", "isPrimary", "createdAt", "updatedAt", "deletedAt")
SELECT "id", 'expense', 'notion', 'page', "notionPageId", NULL::text, true, "createdAt", "updatedAt", "deletedAt"
FROM "Expense" WHERE "notionPageId" IS NOT NULL
UNION ALL
SELECT "id", 'task', 'notion', 'page', "notionPageId", NULL, true, "createdAt", "updatedAt", "deletedAt"
FROM "Task" WHERE "notionPageId" IS NOT NULL
UNION ALL
SELECT "id", 'project', 'notion', 'page', "notionPageId", "notionPageUrl", true, "createdAt", "updatedAt", "deletedAt"
FROM "Project" WHERE "notionPageId" IS NOT NULL
UNION ALL
SELECT "id", 'project', 'google-drive', 'folder',
  substring("googleDriveFolderUrl" from 'folders/([A-Za-z0-9_-]+)'), "googleDriveFolderUrl", true,
  "createdAt", "updatedAt", "deletedAt"
FROM "Project" WHERE "googleDriveFolderUrl" IS NOT NULL
UNION ALL
SELECT "id", 'recipe', 'notion', 'page', "SourceData", NULL, true, "createdAt", "updatedAt", "deletedAt"
FROM "Recipe" WHERE "SourceType" = 'Notion';
--> statement-breakpoint

ALTER TABLE "EntityExternalId" ADD CONSTRAINT "EntityExternalId_source_ExternalSource_slug_fk"
  FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "EntityExternalId" ADD CONSTRAINT "EntityExternalId_entity_fk"
  FOREIGN KEY ("entityId", "entityKind") REFERENCES "public"."Entity"("id", "kind") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "EntityExternalId_source_kind_externalId_key" ON "EntityExternalId" USING btree ("source", "kind", "externalId")
  WHERE "EntityExternalId"."deletedAt" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "EntityExternalId_entity_source_kind_primary_key" ON "EntityExternalId" USING btree ("entityId", "source", "kind")
  WHERE "EntityExternalId"."isPrimary" AND "EntityExternalId"."deletedAt" IS NULL;
--> statement-breakpoint
CREATE INDEX "EntityExternalId_entityId_idx" ON "EntityExternalId" USING btree ("entityId");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Every source column names a registered source.
-- ---------------------------------------------------------------------------
ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_source_ExternalSource_slug_fk"
  FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "StatementRow" ADD CONSTRAINT "StatementRow_source_ExternalSource_slug_fk"
  FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "LedgerSourceClaim" ADD CONSTRAINT "LedgerSourceClaim_source_ExternalSource_slug_fk"
  FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Recipe source split: sourceType text + CHECK; sourceUrl for Website rows;
-- sourceLabel for Book rows with no Cookbook; Notion page ids moved above;
-- cookbook recipes are named by their Cookbook.
-- ---------------------------------------------------------------------------
DROP INDEX "Recipe_name_key";
--> statement-breakpoint
DROP INDEX "Recipe_book_title_key";
--> statement-breakpoint
DROP INDEX "Recipe_notion_page_key";
--> statement-breakpoint
DROP INDEX "Recipe_SourceType_idx";
--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN "sourceUrl" text;
--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN "sourceLabel" text;
--> statement-breakpoint
UPDATE "Recipe" SET "sourceUrl" = "SourceData" WHERE "SourceType" = 'Website';
--> statement-breakpoint
UPDATE "Recipe" SET "sourceLabel" = "SourceData" WHERE "SourceType" = 'Book' AND "cookbookId" IS NULL;
--> statement-breakpoint
ALTER TABLE "Recipe" ALTER COLUMN "SourceType" SET DATA TYPE text USING "SourceType"::text;
--> statement-breakpoint
ALTER TABLE "Recipe" RENAME COLUMN "SourceType" TO "sourceType";
--> statement-breakpoint
ALTER TABLE "Recipe" DROP COLUMN "SourceData";
--> statement-breakpoint
DROP TYPE "public"."RecipeSource";
--> statement-breakpoint
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_sourceType_check"
  CHECK ("sourceType" IS NULL OR "sourceType" IN ('Book', 'Website', 'Other', 'Notion'));
--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_name_key" ON "Recipe" USING btree ("name")
  WHERE "Recipe"."deletedAt" IS NULL AND "Recipe"."sourceType" IS DISTINCT FROM 'Book' AND "Recipe"."sourceType" IS DISTINCT FROM 'Notion';
--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_cookbookId_name_key" ON "Recipe" USING btree ("cookbookId", "name")
  WHERE "Recipe"."cookbookId" IS NOT NULL AND "Recipe"."deletedAt" IS NULL;
--> statement-breakpoint
CREATE INDEX "Recipe_sourceType_idx" ON "Recipe" USING btree ("sourceType");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Retire the old homes.
-- ---------------------------------------------------------------------------
DROP TABLE "ProductExternalId";
--> statement-breakpoint
ALTER TABLE "FinancialTransaction" DROP COLUMN "sourceRefs";
--> statement-breakpoint
ALTER TABLE "Expense" DROP COLUMN "notionPageId";
--> statement-breakpoint
ALTER TABLE "Task" DROP COLUMN "notionPageId";
--> statement-breakpoint
ALTER TABLE "Project" DROP COLUMN "notionPageId";
--> statement-breakpoint
ALTER TABLE "Project" DROP COLUMN "notionPageUrl";
--> statement-breakpoint
ALTER TABLE "Project" DROP COLUMN "googleDriveFolderUrl";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Post-check: every identifier arrived (total and live), and settlement
-- status and the settlement-reference gap are unchanged under the new rule.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  drift text;
BEGIN
  SELECT string_agg(coalesce(pre."what", post."what") || ' ' || coalesce(pre."rows", 0) || '/' || coalesce(pre."live", 0)
      || '->' || coalesce(post."rows", 0) || '/' || coalesce(post."live", 0), ', ')
  INTO drift
  FROM "_xid_pre" pre
  FULL JOIN (
    SELECT CASE WHEN "kind" = 'page' THEN 'page:' || "entityKind"
                WHEN "kind" = 'folder' THEN 'folder:' || "entityKind"
                WHEN "kind" = 'settlement_ref' THEN 'settlement_ref'
                ELSE 'product' END AS "what",
      count(*) AS "rows", count(*) FILTER (WHERE "deletedAt" IS NULL) AS "live"
    FROM "EntityExternalId" GROUP BY 1
  ) post USING ("what")
  WHERE coalesce(pre."rows", 0) <> coalesce(post."rows", 0)
     OR coalesce(pre."live", 0) <> coalesce(post."live", 0);
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'external-id: identifier counts changed (total/live): %', drift;
  END IF;

  WITH agg AS (
    SELECT a."purchaseId",
      count(DISTINCT a."transactionId") AS "txn",
      count(DISTINCT a."transactionId") FILTER (WHERE ft."status" IN ('expected', 'pending')) AS "outstanding",
      COALESCE(sum(a."amount") FILTER (WHERE ft."status" = 'posted'), 0)::double precision AS "posted",
      COALESCE(sum(a."amount"), 0)::double precision AS "projected"
    FROM "FinancialTransactionAllocation" a
    JOIN "FinancialTransaction" ft ON ft."id" = a."transactionId"
    WHERE a."deletedAt" IS NULL AND ft."deletedAt" IS NULL
      AND ft."kind" IN ('purchase', 'refund', 'adjustment', 'income')
      AND ft."status" <> 'void'
    GROUP BY 1
  ), purchase AS (
    SELECT p."id",
      (SELECT COALESCE(sum(e."cost"), 0)::double precision FROM "Expense" e
        WHERE e."purchaseId" = p."id" AND e."deletedAt" IS NULL AND e."future" = false) AS "expense",
      (SELECT count(*) FROM "Expense" e
        WHERE e."purchaseId" = p."id" AND e."cost" IS NULL AND e."deletedAt" IS NULL AND e."future" = false) AS "unpriced",
      NOT EXISTS (
        SELECT 1 FROM "FinancialTransactionAllocation" sr_a
        JOIN "FinancialTransaction" sr_ft ON sr_ft."id" = sr_a."transactionId" AND sr_ft."deletedAt" IS NULL
        JOIN "FinancialAccount" sr_fa ON sr_fa."id" = sr_ft."accountId" AND sr_fa."deletedAt" IS NULL
        WHERE sr_a."purchaseId" = p."id" AND sr_a."deletedAt" IS NULL
          AND sr_ft."status" = 'posted'
          AND sr_ft."kind" IN ('purchase', 'refund', 'adjustment', 'income')
          AND (EXISTS (
                SELECT 1 FROM "EntityExternalId" sr_x
                WHERE sr_x."entityId" = sr_ft."id" AND sr_x."kind" = 'settlement_ref'
                  AND sr_x."deletedAt" IS NULL)
               OR sr_fa."identity"->>'kind' = 'cash')
      ) AS "gap"
    FROM "Purchase" p WHERE p."deletedAt" IS NULL
  ), post AS (
    SELECT
      CASE
        WHEN NOT (purchase."unpriced" = 0 AND COALESCE(agg."txn", 0) > 0) THEN 'unknown'
        WHEN agg."outstanding" > 0 AND floor(agg."projected" * 100 + 0.5) = floor(purchase."expense" * 100 + 0.5) THEN 'pending'
        WHEN agg."outstanding" = 0 AND floor(agg."posted" * 100 + 0.5) = floor(purchase."expense" * 100 + 0.5) THEN 'match'
        ELSE 'mismatch'
      END AS "status",
      purchase."gap",
      count(*) AS "purchases"
    FROM purchase LEFT JOIN agg ON agg."purchaseId" = purchase."id"
    GROUP BY 1, 2
  )
  SELECT string_agg(coalesce(pre."status", post."status") || '/gap=' || coalesce(pre."gap", post."gap")
      || ' ' || coalesce(pre."purchases", 0) || '->' || coalesce(post."purchases", 0), ', ')
  INTO drift
  FROM "_xid_pre_settlement" pre
  FULL JOIN post USING ("status", "gap")
  WHERE coalesce(pre."purchases", 0) <> coalesce(post."purchases", 0);
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'external-id: purchase settlement status or reference gap changed: %', drift;
  END IF;
END $$;
