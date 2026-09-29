-- Composed by tooling/db-compose-migration.ts from drizzle/transform/.
-- transform/00-guard.sql
-- Guard: snapshot the invariants the whole cleanup must preserve, before any
-- slice runs. Everything here is relative (compared again in 90-post-check),
-- so it holds on an empty test database and on production alike. Absolute
-- production expectations live in the external verification script.
CREATE TEMP TABLE "_cleanup_pre_money" ON COMMIT DROP AS
SELECT
  coalesce(date_trunc('month', "date"), '-infinity') AS "month",
  ("deletedAt" IS NULL) AS "live",
  count(*) AS "lines",
  -- numeric, not the double precision column: a float sum's value depends on
  -- scan order (parallel aggregates), which would false-fail the post-check.
  coalesce(sum("cost"::numeric), 0) AS "cost"
FROM "Expense"
GROUP BY 1, 2;
--> statement-breakpoint
CREATE TEMP TABLE "_cleanup_pre_counts" ON COMMIT DROP AS
SELECT 'Expense' AS "table", count(*) AS "rows" FROM "Expense"
UNION ALL SELECT 'Purchase', count(*) FROM "Purchase"
UNION ALL SELECT 'Vendor', count(*) FROM "Vendor"
UNION ALL SELECT 'FinancialAccount', count(*) FROM "FinancialAccount"
UNION ALL SELECT 'FinancialTransaction', count(*) FROM "FinancialTransaction"
UNION ALL SELECT 'FinancialTransactionAllocation', count(*) FROM "FinancialTransactionAllocation"
UNION ALL SELECT 'StatementRow', count(*) FROM "StatementRow"
UNION ALL SELECT 'Product', count(*) FROM "Product"
UNION ALL SELECT 'Ingredient', count(*) FROM "Ingredient"
UNION ALL SELECT 'Recipe', count(*) FROM "Recipe"
UNION ALL SELECT 'RecipeSectionIngredient', count(*) FROM "RecipeSectionIngredient"
UNION ALL SELECT 'Location', count(*) FROM "Location"
UNION ALL SELECT 'InventoryEntry', count(*) FROM "InventoryEntry"
UNION ALL SELECT 'Project', count(*) FROM "Project"
UNION ALL SELECT 'Task', count(*) FROM "Task"
UNION ALL SELECT 'Image', count(*) FROM "Image"
UNION ALL SELECT 'EntityAttachment', count(*) FROM "EntityAttachment"
UNION ALL SELECT 'AiUsage', count(*) FROM "AiUsage";
--> statement-breakpoint
CREATE TEMP TABLE "_cleanup_pre_entities" ON COMMIT DROP AS
SELECT "kind", count(*) AS "rows", count(*) FILTER (WHERE "deletedAt" IS NULL) AS "live"
FROM "Entity"
GROUP BY 1;
--> statement-breakpoint
-- transform/10-entity-ref.sql
-- entityRef: one vocabulary for "a column that points at any entity".
-- `entityId` (Entity.id) + `entityKind`, bound by a composite FK to
-- Entity(id, kind). Plain Postgres DDL and backfills, no BEGIN/COMMIT: the
-- caller runs every transform fragment in one transaction. Names match what
-- Drizzle emits for apps/web/src/server/db/schema.ts.

-- ---------------------------------------------------------------------------
-- AuditLog: entityType -> entityKind
-- ---------------------------------------------------------------------------
ALTER TABLE "AuditLog" RENAME COLUMN "entityType" TO "entityKind";
ALTER INDEX "AuditLog_entityType_entityId_createdAt_idx"
  RENAME TO "AuditLog_entityKind_entityId_createdAt_idx";

-- ---------------------------------------------------------------------------
-- EntityEmbedding: entityType -> entityKind
-- ---------------------------------------------------------------------------
ALTER TABLE "EntityEmbedding" RENAME COLUMN "entityType" TO "entityKind";

-- ---------------------------------------------------------------------------
-- SearchDocument: entityType -> entityKind; shortcode is read from Entity
-- ---------------------------------------------------------------------------
DROP INDEX "SearchDocument_shortcode_active_idx";
ALTER TABLE "SearchDocument" DROP COLUMN "shortcode";
ALTER TABLE "SearchDocument" RENAME COLUMN "entityType" TO "entityKind";

-- ---------------------------------------------------------------------------
-- McpToolCall: entity -> entityKind
-- ---------------------------------------------------------------------------
ALTER TABLE "McpToolCall" RENAME COLUMN "entity" TO "entityKind";

-- ---------------------------------------------------------------------------
-- SuggestionDismissal: sourceEntityType/sourceEntityId -> entityKind/entityId
-- (empty in production; the FK is safe to add over the existing rows)
-- ---------------------------------------------------------------------------
ALTER TABLE "SuggestionDismissal" RENAME COLUMN "sourceEntityType" TO "entityKind";
ALTER TABLE "SuggestionDismissal" RENAME COLUMN "sourceEntityId" TO "entityId";
ALTER TABLE "SuggestionDismissal"
  ADD CONSTRAINT "SuggestionDismissal_entity_fk"
  FOREIGN KEY ("entityId", "entityKind") REFERENCES "Entity" ("id", "kind");

-- ---------------------------------------------------------------------------
-- RunFinding: targetKind/targetId -> entityKind/entityId
-- ---------------------------------------------------------------------------
ALTER TABLE "RunFinding" RENAME COLUMN "targetKind" TO "entityKind";
ALTER TABLE "RunFinding" RENAME COLUMN "targetId" TO "entityId";
ALTER TABLE "RunFinding"
  RENAME CONSTRAINT "RunFinding_target_fk" TO "RunFinding_entity_fk";
ALTER TABLE "RunFinding"
  RENAME CONSTRAINT "RunFinding_target_check" TO "RunFinding_entityKind_check";

-- ---------------------------------------------------------------------------
-- EntityAttachment: subjectEntityId -> entityId, plus the stored entityKind
-- ---------------------------------------------------------------------------
ALTER TABLE "EntityAttachment"
  DROP CONSTRAINT "EntityAttachment_subjectEntityId_Entity_id_fk";
ALTER TABLE "EntityAttachment" RENAME COLUMN "subjectEntityId" TO "entityId";
ALTER TABLE "EntityAttachment" ADD COLUMN "entityKind" text;
UPDATE "EntityAttachment" AS a
  SET "entityKind" = e."kind"
  FROM "Entity" AS e
  WHERE e."id" = a."entityId";
ALTER TABLE "EntityAttachment" ALTER COLUMN "entityKind" SET NOT NULL;
ALTER TABLE "EntityAttachment"
  ADD CONSTRAINT "EntityAttachment_entity_fk"
  FOREIGN KEY ("entityId", "entityKind") REFERENCES "Entity" ("id", "kind");
-- Both CHECKs fail the whole transaction if a legacy row breaks the rule
-- (purpose set on a non-product, documentKind set on a non-purchase); count
-- such rows before applying.
ALTER TABLE "EntityAttachment"
  ADD CONSTRAINT "EntityAttachment_purpose_kind_check"
  CHECK ("purpose" IS NULL OR "entityKind" = 'product');
ALTER TABLE "EntityAttachment"
  ADD CONSTRAINT "EntityAttachment_documentKind_kind_check"
  CHECK ("documentKind" IS NULL OR "entityKind" = 'purchase');
ALTER INDEX "EntityAttachment_subject_image_key"
  RENAME TO "EntityAttachment_entity_image_key";
ALTER INDEX "EntityAttachment_subject_singular_role_key"
  RENAME TO "EntityAttachment_entity_singular_role_key";
ALTER INDEX "EntityAttachment_subject_idempotency_key"
  RENAME TO "EntityAttachment_entity_idempotency_key";
ALTER INDEX "EntityAttachment_subject_order_idx"
  RENAME TO "EntityAttachment_entity_order_idx";

-- ---------------------------------------------------------------------------
-- RunTarget: purchaseId/productId/imageId -> entityId + entityKind
-- ---------------------------------------------------------------------------
ALTER TABLE "RunTarget" DROP CONSTRAINT "RunTarget_exactly_one_target_check";
DROP INDEX "RunTarget_run_purchase_key";
DROP INDEX "RunTarget_run_product_key";
DROP INDEX "RunTarget_run_image_key";
DROP INDEX "RunTarget_purchase_idx";
DROP INDEX "RunTarget_product_idx";
DROP INDEX "RunTarget_image_idx";
ALTER TABLE "RunTarget" DROP CONSTRAINT "RunTarget_purchaseId_Purchase_id_fk";
ALTER TABLE "RunTarget" DROP CONSTRAINT "RunTarget_productId_Product_id_fk";
ALTER TABLE "RunTarget" DROP CONSTRAINT "RunTarget_imageId_Image_id_fk";
ALTER TABLE "RunTarget" ADD COLUMN "entityId" uuid;
ALTER TABLE "RunTarget" ADD COLUMN "entityKind" text;
UPDATE "RunTarget"
  SET "entityId" = COALESCE("purchaseId", "productId", "imageId"),
      "entityKind" = CASE
        WHEN "purchaseId" IS NOT NULL THEN 'purchase'
        WHEN "productId" IS NOT NULL THEN 'product'
        ELSE 'image'
      END;
ALTER TABLE "RunTarget" ALTER COLUMN "entityId" SET NOT NULL;
ALTER TABLE "RunTarget" ALTER COLUMN "entityKind" SET NOT NULL;
ALTER TABLE "RunTarget" DROP COLUMN "purchaseId";
ALTER TABLE "RunTarget" DROP COLUMN "productId";
ALTER TABLE "RunTarget" DROP COLUMN "imageId";
ALTER TABLE "RunTarget"
  ADD CONSTRAINT "RunTarget_entityKind_check"
  CHECK ("entityKind" IN ('purchase', 'product', 'image'));
CREATE UNIQUE INDEX "RunTarget_run_entity_key"
  ON "RunTarget" USING btree ("runId", "entityId");
CREATE INDEX "RunTarget_entity_idx"
  ON "RunTarget" USING btree ("entityId");
ALTER TABLE "RunTarget"
  ADD CONSTRAINT "RunTarget_entity_fk"
  FOREIGN KEY ("entityId", "entityKind") REFERENCES "Entity" ("id", "kind");
--> statement-breakpoint
-- transform/20-entity-link.sql
-- EntityLink (ADR 0007): the seven same-shaped join tables become one generic
-- link table. Ids and timestamps are kept; `from` is the owning side (wish,
-- purchase, project, garden entry, kit, blocked task, blocked project), per
-- packages/schemas/src/entity-links.ts. Dependencies had no deletedAt and
-- become soft-deletable. Plain DDL and backfills, no BEGIN/COMMIT: every
-- transform fragment runs in one transaction. Names match what Drizzle emits
-- for apps/web/src/server/db/schema.ts.

CREATE TEMP TABLE "_link_pre" ON COMMIT DROP AS
SELECT 'wishCandidate' AS "kind", count(*) AS "rows", count(*) FILTER (WHERE "deletedAt" IS NULL) AS "live" FROM "WishCandidate"
UNION ALL SELECT 'purchaseProduct', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL) FROM "PurchaseProduct"
UNION ALL SELECT 'projectTool', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL) FROM "ProjectToolUsage"
UNION ALL SELECT 'gardenEntryPlanting', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL) FROM "GardenEntryPlanting"
UNION ALL SELECT 'productComponent', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL) FROM "ProductComponent"
UNION ALL SELECT 'taskDependency', count(*), count(*) FROM "TaskDependency"
UNION ALL SELECT 'projectDependency', count(*), count(*) FROM "ProjectDependency";
--> statement-breakpoint

CREATE TABLE "EntityLink" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "fromEntityId" uuid NOT NULL,
  "fromKind" text NOT NULL,
  "toEntityId" uuid NOT NULL,
  "toKind" text NOT NULL,
  "quantity" integer,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  "deletedAt" timestamp,
  CONSTRAINT "EntityLink_kind_check" CHECK (("kind", "fromKind", "toKind") IN (
    ('wishCandidate', 'wish', 'product'),
    ('purchaseProduct', 'purchase', 'product'),
    ('projectTool', 'project', 'product'),
    ('gardenEntryPlanting', 'gardenEntry', 'planting'),
    ('productComponent', 'product', 'product'),
    ('taskDependency', 'task', 'task'),
    ('projectDependency', 'project', 'project'))),
  CONSTRAINT "EntityLink_quantity_check" CHECK (CASE WHEN "kind" IN ('productComponent')
    THEN "quantity" IS NOT NULL AND "quantity" >= 1 ELSE "quantity" IS NULL END),
  CONSTRAINT "EntityLink_no_self_check" CHECK ("kind" NOT IN ('productComponent', 'taskDependency', 'projectDependency')
    OR "fromEntityId" <> "toEntityId")
);
--> statement-breakpoint
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_from_fk"
  FOREIGN KEY ("fromEntityId", "fromKind") REFERENCES "Entity" ("id", "kind");
--> statement-breakpoint
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_to_fk"
  FOREIGN KEY ("toEntityId", "toKind") REFERENCES "Entity" ("id", "kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "EntityLink_kind_from_to_key" ON "EntityLink" USING btree ("kind", "fromEntityId", "toEntityId")
  WHERE "EntityLink"."deletedAt" IS NULL;
--> statement-breakpoint
CREATE INDEX "EntityLink_to_kind_idx" ON "EntityLink" USING btree ("toEntityId", "kind")
  WHERE "EntityLink"."deletedAt" IS NULL;
--> statement-breakpoint

INSERT INTO "EntityLink" ("id", "kind", "fromEntityId", "fromKind", "toEntityId", "toKind", "quantity", "createdAt", "updatedAt", "deletedAt")
SELECT "id", 'wishCandidate', "wishId", 'wish', "productId", 'product', NULL::integer, "createdAt", "updatedAt", "deletedAt" FROM "WishCandidate"
UNION ALL
SELECT "id", 'purchaseProduct', "purchaseId", 'purchase', "productId", 'product', NULL, "createdAt", "updatedAt", "deletedAt" FROM "PurchaseProduct"
UNION ALL
SELECT "id", 'projectTool', "projectId", 'project', "productId", 'product', NULL, "createdAt", "updatedAt", "deletedAt" FROM "ProjectToolUsage"
UNION ALL
SELECT "id", 'gardenEntryPlanting', "gardenEntryId", 'gardenEntry', "plantingId", 'planting', NULL, "createdAt", "updatedAt", "deletedAt" FROM "GardenEntryPlanting"
UNION ALL
SELECT "id", 'productComponent', "parentProductId", 'product', "componentProductId", 'product', "quantity", "createdAt", "updatedAt", "deletedAt" FROM "ProductComponent"
UNION ALL
SELECT "id", 'taskDependency', "taskId", 'task', "blockedByTaskId", 'task', NULL, "createdAt", "updatedAt", NULL::timestamp FROM "TaskDependency"
UNION ALL
SELECT "id", 'projectDependency', "projectId", 'project', "blockedByProjectId", 'project', NULL, "createdAt", "updatedAt", NULL FROM "ProjectDependency";
--> statement-breakpoint

-- Installed after the copy (production has no live link to a deleted entity;
-- the post-check below proves it). Identical to derived-ddl.ts.
CREATE OR REPLACE FUNCTION "entity_link_require_live_endpoints"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Entity"
    WHERE "id" IN (NEW."fromEntityId", NEW."toEntityId")
      AND "deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'EntityLink % (%) names a deleted entity: % -> %',
      NEW."id", NEW."kind", NEW."fromEntityId", NEW."toEntityId"
      USING ERRCODE = '23503', CONSTRAINT = 'EntityLink_live_endpoints_check';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "EntityLink_live_endpoints" ON "EntityLink";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "EntityLink_live_endpoints" AFTER INSERT OR UPDATE ON "EntityLink"
  FOR EACH ROW WHEN (NEW."deletedAt" IS NULL)
  EXECUTE FUNCTION "entity_link_require_live_endpoints"();
--> statement-breakpoint

DROP TABLE "WishCandidate";
--> statement-breakpoint
DROP TABLE "PurchaseProduct";
--> statement-breakpoint
DROP TABLE "ProjectToolUsage";
--> statement-breakpoint
DROP TABLE "GardenEntryPlanting";
--> statement-breakpoint
DROP TABLE "ProductComponent";
--> statement-breakpoint
DROP TABLE "TaskDependency";
--> statement-breakpoint
DROP TABLE "ProjectDependency";
--> statement-breakpoint

DO $$
DECLARE
  drift text;
BEGIN
  SELECT string_agg(coalesce(pre."kind", post."kind") || ' ' || coalesce(pre."rows", 0) || '/' || coalesce(pre."live", 0)
      || '->' || coalesce(post."rows", 0) || '/' || coalesce(post."live", 0), ', ')
  INTO drift
  FROM "_link_pre" pre
  FULL JOIN (
    SELECT "kind", count(*) AS "rows", count(*) FILTER (WHERE "deletedAt" IS NULL) AS "live"
    FROM "EntityLink" GROUP BY 1
  ) post USING ("kind")
  WHERE coalesce(pre."rows", 0) <> coalesce(post."rows", 0)
     OR coalesce(pre."live", 0) <> coalesce(post."live", 0);
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'EntityLink copy changed link counts (total/live): %', drift;
  END IF;

  SELECT string_agg(l."kind" || ' ' || l."id", ', ')
  INTO drift
  FROM "EntityLink" l
  JOIN "Entity" e ON e."id" IN (l."fromEntityId", l."toEntityId")
  WHERE l."deletedAt" IS NULL AND e."deletedAt" IS NOT NULL;
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'EntityLink copy produced live links to deleted entities: %', drift;
  END IF;
END $$;
--> statement-breakpoint
-- transform/30-external-id.sql
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
--> statement-breakpoint
-- transform/40-image-sighting.sql
-- ImageSighting: entity -> non-entity child of Image (ADR 0005). The table and
-- its uuids stay; its identity (shortcode, identity FK, identity triggers,
-- Entity rows) goes. Its audit history moves onto the parent Image first, a
-- deliberate exception to ADR 0006's "Entity rows are never deleted".
-- Plain Postgres DDL and backfills, no BEGIN/COMMIT: the caller runs every
-- transform fragment in one transaction. Names match what Drizzle emits for
-- apps/web/src/server/db/schema.ts.

-- Relative checks at the end compare against these counts.
CREATE TEMP TABLE "_image_sighting_demotion_pre" AS
  SELECT (SELECT count(*) FROM "AuditLog") AS "auditTotal",
         (SELECT count(*) FROM "ImageSighting") AS "sightings";

-- 1. Drop the identity binding: the derived triggers keep an Entity row in
-- step with the payload, so they go before any Entity row is deleted.
DROP TRIGGER IF EXISTS "Entity_identity_insert" ON "ImageSighting";
DROP TRIGGER IF EXISTS "Entity_identity_soft_delete" ON "ImageSighting";
DROP TRIGGER IF EXISTS "Entity_identity_delete" ON "ImageSighting";
ALTER TABLE "ImageSighting" DROP CONSTRAINT "ImageSighting_entity_identity_fk";
DROP INDEX "ImageSighting_shortcode_unique";

-- 2. Rewrite each sighting's audit rows onto its Image. The Image is the
-- audit subject now, so the row is an update of the Image; the sighting's own
-- diff (null for every row written before this migration) nests under its id.
UPDATE "AuditLog" AS a
  SET "entityKind" = 'image',
      "entityId" = s."imageId",
      "action" = 'update',
      "changes" = jsonb_build_object(
        'sightings',
        jsonb_build_object(s."id"::text, COALESCE(a."changes", '{}'::jsonb))
      )
  FROM "ImageSighting" AS s
  WHERE a."entityKind" = 'imageSighting' AND a."entityId" = s."id";

-- 3. Guard: nothing may still point at a sighting identity. Audit rows whose
-- sighting row is gone cannot be rewritten (no parent Image); every other
-- reference is found through the foreign keys onto Entity, so a table another
-- slice adds is covered too.
DO $$
DECLARE
  fk record;
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "AuditLog" WHERE "entityKind" = 'imageSighting';
  IF n > 0 THEN
    RAISE EXCEPTION 'ImageSighting demotion: % AuditLog rows name a sighting that no longer exists', n;
  END IF;
  SELECT count(*) INTO n FROM "Entity"
    WHERE "mergedIntoId" IN (SELECT "id" FROM "ImageSighting");
  IF n > 0 THEN
    RAISE EXCEPTION 'ImageSighting demotion: % Entity rows were merged into a sighting', n;
  END IF;
  FOR fk IN
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint AS c
    JOIN pg_attribute AS a
      ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confrelid = '"Entity"'::regclass
      AND c.conrelid NOT IN ('"Entity"'::regclass, '"AuditLog"'::regclass)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s WHERE %I IN (SELECT "id" FROM "ImageSighting")',
      fk.tbl, fk.col
    ) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'ImageSighting demotion: % rows in %.% still reference a sighting identity', n, fk.tbl, fk.col;
    END IF;
  END LOOP;
END $$;

-- 4. Delete the identity rows, then the shortcode.
DELETE FROM "Entity" WHERE "kind" = 'imageSighting';
ALTER TABLE "ImageSighting" DROP COLUMN "shortcode";

-- 5. A sighting cannot outlive its Image.
ALTER TABLE "ImageSighting" DROP CONSTRAINT "ImageSighting_imageId_Image_id_fk";
ALTER TABLE "ImageSighting"
  ADD CONSTRAINT "ImageSighting_imageId_Image_id_fk"
  FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id")
  ON DELETE cascade ON UPDATE no action;

-- 6. `imageSighting` and its IMS- prefix leave the Entity CHECKs (after the
-- DELETE above, so no row violates the new rule).
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_kind_check";
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_shortcode_prefix_check";
ALTER TABLE "Entity"
  ADD CONSTRAINT "Entity_kind_check" CHECK ("Entity"."kind" IN ('product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory', 'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor', 'purchase', 'financialAccount', 'financialTransaction', 'wish', 'expense', 'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory', 'run', 'device', 'plant'));
ALTER TABLE "Entity"
  ADD CONSTRAINT "Entity_shortcode_prefix_check" CHECK ("Entity"."shortcode" IS NULL OR CASE "Entity"."kind" WHEN 'product' THEN "Entity"."shortcode" LIKE 'PRD-%' WHEN 'recipe' THEN "Entity"."shortcode" LIKE 'RCP-%' WHEN 'ingredient' THEN "Entity"."shortcode" LIKE 'ING-%' WHEN 'cookbook' THEN "Entity"."shortcode" LIKE 'CKB-%' WHEN 'location' THEN "Entity"."shortcode" LIKE 'LOC-%' WHEN 'inventory' THEN "Entity"."shortcode" LIKE 'INV-%' WHEN 'meal' THEN "Entity"."shortcode" LIKE 'MEL-%' WHEN 'ledgerParty' THEN "Entity"."shortcode" LIKE 'LPY-%' WHEN 'ledgerTransfer' THEN "Entity"."shortcode" LIKE 'LTR-%' WHEN 'project' THEN "Entity"."shortcode" LIKE 'PRJ-%' WHEN 'task' THEN "Entity"."shortcode" LIKE 'TSK-%' WHEN 'vendor' THEN "Entity"."shortcode" LIKE 'VEN-%' WHEN 'purchase' THEN "Entity"."shortcode" LIKE 'PUR-%' WHEN 'financialAccount' THEN "Entity"."shortcode" LIKE 'FAC-%' WHEN 'financialTransaction' THEN "Entity"."shortcode" LIKE 'FTX-%' WHEN 'wish' THEN "Entity"."shortcode" LIKE 'WSH-%' WHEN 'expense' THEN "Entity"."shortcode" LIKE 'EXP-%' WHEN 'image' THEN "Entity"."shortcode" LIKE 'IMG-%' WHEN 'planting' THEN "Entity"."shortcode" LIKE 'PLT-%' WHEN 'gardenEntry' THEN "Entity"."shortcode" LIKE 'GDE-%' WHEN 'vendorAccount' THEN "Entity"."shortcode" LIKE 'VACCT-%' WHEN 'productCategory' THEN "Entity"."shortcode" LIKE 'CAT-%' WHEN 'run' THEN "Entity"."shortcode" LIKE 'RUN-%' WHEN 'device' THEN "Entity"."shortcode" LIKE 'DEV-%' WHEN 'plant' THEN "Entity"."shortcode" LIKE 'PLANT-%' ELSE false END);

-- 7. Relative checks: audit history moved, none lost; no sighting identity
-- left; no sighting row lost.
DO $$
DECLARE
  pre record;
  n bigint;
BEGIN
  SELECT * INTO pre FROM "_image_sighting_demotion_pre";
  SELECT count(*) INTO n FROM "AuditLog";
  IF n <> pre."auditTotal" THEN
    RAISE EXCEPTION 'ImageSighting demotion: AuditLog total changed from % to %', pre."auditTotal", n;
  END IF;
  SELECT count(*) INTO n FROM "AuditLog" WHERE "entityKind" = 'imageSighting';
  IF n <> 0 THEN
    RAISE EXCEPTION 'ImageSighting demotion: % AuditLog rows still name imageSighting', n;
  END IF;
  SELECT count(*) INTO n FROM "Entity" WHERE "kind" = 'imageSighting';
  IF n <> 0 THEN
    RAISE EXCEPTION 'ImageSighting demotion: % Entity rows still have kind imageSighting', n;
  END IF;
  SELECT count(*) INTO n FROM "ImageSighting";
  IF n <> pre."sightings" THEN
    RAISE EXCEPTION 'ImageSighting demotion: ImageSighting rows changed from % to %', pre."sightings", n;
  END IF;
END $$;
DROP TABLE "_image_sighting_demotion_pre";
--> statement-breakpoint
-- transform/50-shape.sql
-- Shapes: jsonb {value, unit} -> two columns, pgEnums -> text + CHECK,
-- derived-but-stored columns -> computed on read, naming, Location type, and
-- redundant index drops. Plain Postgres DDL and backfills, no BEGIN/COMMIT: the
-- caller runs every transform fragment in one transaction. Constraint and index
-- names match what Drizzle emits for apps/web/src/server/db/schema.ts.

-- ---------------------------------------------------------------------------
-- Pre-snapshot (relative checks at the end compare against it)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE "_shape_pre" (k text PRIMARY KEY, n bigint NOT NULL, v numeric)
  ON COMMIT DROP;
INSERT INTO "_shape_pre" (k, n) VALUES
  ('InventoryEntry', (SELECT count(*) FROM "InventoryEntry")),
  ('ProductUnitMappings', (SELECT count(*) FROM "ProductUnitMappings")),
  ('MealFoodEntry', (SELECT count(*) FROM "MealFoodEntry")),
  ('MealRecipePortion', (SELECT count(*) FROM "MealRecipePortion")),
  ('Location', (SELECT count(*) FROM "Location")),
  ('Cookbook', (SELECT count(*) FROM "Cookbook")),
  ('VendorAccount', (SELECT count(*) FROM "VendorAccount")),
  ('GardenEntry', (SELECT count(*) FROM "GardenEntry")),
  ('Recipe', (SELECT count(*) FROM "Recipe")),
  ('Image', (SELECT count(*) FROM "Image"));
-- Amount sums per unit, for every reshaped amount (unit key 'a'/'b' for the
-- two sides of a unit mapping).
INSERT INTO "_shape_pre" (k, n, v)
  SELECT 'inv:' || (amount->>'unit'), count(*), sum((amount->>'value')::numeric)
  FROM "InventoryEntry" GROUP BY amount->>'unit';
INSERT INTO "_shape_pre" (k, n, v)
  SELECT 'unitmap:a:' || (a->>'unit'), count(*), sum((a->>'value')::numeric)
  FROM "ProductUnitMappings" GROUP BY a->>'unit';
INSERT INTO "_shape_pre" (k, n, v)
  SELECT 'unitmap:b:' || (b->>'unit'), count(*), sum((b->>'value')::numeric)
  FROM "ProductUnitMappings" GROUP BY b->>'unit';
INSERT INTO "_shape_pre" (k, n, v)
  SELECT 'food:' || (amount->>'unit'), count(*), sum((amount->>'value')::numeric)
  FROM "MealFoodEntry" WHERE amount IS NOT NULL GROUP BY amount->>'unit';
INSERT INTO "_shape_pre" (k, n, v)
  SELECT 'portion:' || (amount->>'unit'), count(*), sum((amount->>'value')::numeric)
  FROM "MealRecipePortion" GROUP BY amount->>'unit';
INSERT INTO "_shape_pre" (k, n)
  SELECT 'aidesc:live_location_with_description', count(*)
  FROM "Location" WHERE "aiDescription" IS NOT NULL AND btrim("aiDescription") <> '';

-- ---------------------------------------------------------------------------
-- Guards: every assumption the transform below rests on
-- ---------------------------------------------------------------------------
DO $$
DECLARE bad bigint;
BEGIN
  -- Every stored amount is a numeric value plus a non-empty unit.
  SELECT count(*) INTO bad FROM "InventoryEntry"
    WHERE jsonb_typeof(amount) IS DISTINCT FROM 'object'
       OR jsonb_typeof(amount->'value') IS DISTINCT FROM 'number'
       OR jsonb_typeof(amount->'unit') IS DISTINCT FROM 'string'
       OR length(btrim(amount->>'unit')) = 0
       -- no range (upperValue) or other key: the column pair cannot hold it
       OR amount - 'value' - 'unit' <> '{}'::jsonb;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % InventoryEntry amounts are not {value:number, unit:string}', bad; END IF;

  SELECT count(*) INTO bad FROM "ProductUnitMappings"
    WHERE jsonb_typeof(a->'value') IS DISTINCT FROM 'number'
       OR jsonb_typeof(b->'value') IS DISTINCT FROM 'number'
       OR jsonb_typeof(a->'unit') IS DISTINCT FROM 'string'
       OR jsonb_typeof(b->'unit') IS DISTINCT FROM 'string'
       OR length(btrim(a->>'unit')) = 0 OR length(btrim(b->>'unit')) = 0
       OR a - 'value' - 'unit' <> '{}'::jsonb OR b - 'value' - 'unit' <> '{}'::jsonb;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % ProductUnitMappings sides are not {value:number, unit:string}', bad; END IF;

  -- The MealFoodEntry / MealRecipePortion CHECKs already enforced this shape.
  SELECT count(*) INTO bad FROM "MealRecipePortion" WHERE amount IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % MealRecipePortion rows without an amount', bad; END IF;

  -- The Location.type NOT NULL backfill: only Product-linked rows may lack one.
  SELECT count(*) INTO bad FROM "Location" WHERE type IS NULL AND "productId" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % locations have neither a type nor a product', bad; END IF;

  -- Cookbook.sourceRecipeCount is derivable from the stored extraction.
  SELECT count(*) INTO bad FROM "Cookbook"
    WHERE "sourceRecipeCount" IS DISTINCT FROM (
      CASE WHEN jsonb_typeof("rawJson") = 'array' THEN jsonb_array_length("rawJson")
      ELSE (
        SELECT count(*) FROM jsonb_array_elements("rawJson"->'chapters') AS chapter,
          jsonb_array_elements(chapter->'items') AS item
        WHERE item->>'kind' = 'recipe'
      ) END
    );
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % cookbooks whose stored sourceRecipeCount differs from their extraction', bad; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- InventoryEntry: amount -> amountValue/amountUnit; valuation is computed on read
-- ---------------------------------------------------------------------------
ALTER TABLE "InventoryEntry"
  ADD COLUMN "amountValue" double precision,
  ADD COLUMN "amountUnit" text;
UPDATE "InventoryEntry"
  SET "amountValue" = (amount->>'value')::double precision,
      "amountUnit" = amount->>'unit';
ALTER TABLE "InventoryEntry"
  ALTER COLUMN "amountValue" SET NOT NULL,
  ALTER COLUMN "amountUnit" SET NOT NULL,
  DROP COLUMN "amount",
  DROP COLUMN "valuation";

-- ---------------------------------------------------------------------------
-- ProductUnitMappings -> ProductUnitMapping (aValue/aUnit/bValue/bUnit)
-- ---------------------------------------------------------------------------
ALTER TABLE "ProductUnitMappings" RENAME TO "ProductUnitMapping";
ALTER TABLE "ProductUnitMapping"
  RENAME CONSTRAINT "ProductUnitMappings_pkey" TO "ProductUnitMapping_pkey";
ALTER TABLE "ProductUnitMapping"
  RENAME CONSTRAINT "ProductUnitMappings_productId_Product_id_fk"
  TO "ProductUnitMapping_productId_Product_id_fk";
ALTER INDEX "ProductUnitMappings_productId_idx"
  RENAME TO "ProductUnitMapping_productId_idx";
ALTER TABLE "ProductUnitMapping"
  ADD COLUMN "aValue" double precision,
  ADD COLUMN "aUnit" text,
  ADD COLUMN "bValue" double precision,
  ADD COLUMN "bUnit" text;
UPDATE "ProductUnitMapping"
  SET "aValue" = (a->>'value')::double precision,
      "aUnit" = a->>'unit',
      "bValue" = (b->>'value')::double precision,
      "bUnit" = b->>'unit';
ALTER TABLE "ProductUnitMapping"
  ALTER COLUMN "aValue" SET NOT NULL,
  ALTER COLUMN "aUnit" SET NOT NULL,
  ALTER COLUMN "bValue" SET NOT NULL,
  ALTER COLUMN "bUnit" SET NOT NULL,
  DROP COLUMN a,
  DROP COLUMN b;

-- ---------------------------------------------------------------------------
-- MealFoodEntry / MealRecipePortion: amount -> amountValue/amountUnit + CHECK
-- (the CHECK replaces the jsonb-shape CHECK built by validMealFoodAmount)
-- ---------------------------------------------------------------------------
ALTER TABLE "MealFoodEntry" DROP CONSTRAINT "MealFoodEntry_source_check";
ALTER TABLE "MealFoodEntry" DROP CONSTRAINT "MealFoodEntry_amount_check";
ALTER TABLE "MealFoodEntry"
  ADD COLUMN "amountValue" double precision,
  ADD COLUMN "amountUnit" text;
UPDATE "MealFoodEntry"
  SET "amountValue" = (amount->>'value')::double precision,
      "amountUnit" = amount->>'unit'
  WHERE amount IS NOT NULL;
ALTER TABLE "MealFoodEntry" DROP COLUMN amount;
ALTER TABLE "MealFoodEntry" ADD CONSTRAINT "MealFoodEntry_amount_check" CHECK (
  ("MealFoodEntry"."amountValue" IS NULL AND "MealFoodEntry"."amountUnit" IS NULL) OR (
    "MealFoodEntry"."amountValue" IS NOT NULL AND "MealFoodEntry"."amountUnit" IS NOT NULL
    AND "MealFoodEntry"."amountValue" > 0 AND "MealFoodEntry"."amountValue" < 'Infinity'::double precision
    AND length(trim("MealFoodEntry"."amountUnit")) > 0 AND "MealFoodEntry"."amountUnit" = trim("MealFoodEntry"."amountUnit")
  )
);
ALTER TABLE "MealFoodEntry" ADD CONSTRAINT "MealFoodEntry_source_check" CHECK (("MealFoodEntry"."sourceKind" = 'ingredient' AND "MealFoodEntry"."ingredientId" IS NOT NULL AND "MealFoodEntry"."productId" IS NULL AND "MealFoodEntry"."amountValue" IS NOT NULL AND "MealFoodEntry"."name" IS NULL AND "MealFoodEntry"."nutrients" IS NULL) OR ("MealFoodEntry"."sourceKind" = 'product' AND "MealFoodEntry"."ingredientId" IS NULL AND "MealFoodEntry"."productId" IS NOT NULL AND "MealFoodEntry"."amountValue" IS NOT NULL AND "MealFoodEntry"."name" IS NULL AND "MealFoodEntry"."nutrients" IS NULL) OR ("MealFoodEntry"."sourceKind" = 'manual' AND "MealFoodEntry"."ingredientId" IS NULL AND "MealFoodEntry"."productId" IS NULL AND length(trim("MealFoodEntry"."name")) > 0 AND "MealFoodEntry"."name" IS NOT NULL AND "MealFoodEntry"."nutrients" IS NOT NULL AND jsonb_typeof("MealFoodEntry"."nutrients") = 'object' AND "MealFoodEntry"."nutrients" <> '{}'::jsonb));

ALTER TABLE "MealRecipePortion" DROP CONSTRAINT "MealRecipePortion_amount_check";
ALTER TABLE "MealRecipePortion"
  ADD COLUMN "amountValue" double precision,
  ADD COLUMN "amountUnit" text;
UPDATE "MealRecipePortion"
  SET "amountValue" = (amount->>'value')::double precision,
      "amountUnit" = amount->>'unit';
ALTER TABLE "MealRecipePortion"
  ALTER COLUMN "amountValue" SET NOT NULL,
  ALTER COLUMN "amountUnit" SET NOT NULL,
  DROP COLUMN amount;
ALTER TABLE "MealRecipePortion" ADD CONSTRAINT "MealRecipePortion_amount_check" CHECK (
  ("MealRecipePortion"."amountValue" IS NULL AND "MealRecipePortion"."amountUnit" IS NULL) OR (
    "MealRecipePortion"."amountValue" IS NOT NULL AND "MealRecipePortion"."amountUnit" IS NOT NULL
    AND "MealRecipePortion"."amountValue" > 0 AND "MealRecipePortion"."amountValue" < 'Infinity'::double precision
    AND length(trim("MealRecipePortion"."amountUnit")) > 0 AND "MealRecipePortion"."amountUnit" = trim("MealRecipePortion"."amountUnit")
  )
);

-- ---------------------------------------------------------------------------
-- pgEnums -> text + CHECK (RecipeSource is owned by the Recipe source slice).
-- Every value is kept: PENDING/FAILED and the unverified/missing/mismatch
-- states have no rows today only because they are transient workflow states.
-- ---------------------------------------------------------------------------
ALTER TABLE "Image" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Image" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;
ALTER TABLE "Image" ALTER COLUMN "status" SET DEFAULT 'PENDING';
ALTER TABLE "Image" ALTER COLUMN "renderStatus" SET DATA TYPE text USING "renderStatus"::text;
ALTER TABLE "Image" ALTER COLUMN "storageStatus" SET DATA TYPE text USING "storageStatus"::text;
ALTER TABLE "InventoryEntry" ALTER COLUMN "placement" DROP DEFAULT;
ALTER TABLE "InventoryEntry" ALTER COLUMN "placement" SET DATA TYPE text USING "placement"::text;
ALTER TABLE "InventoryEntry" ALTER COLUMN "placement" SET DEFAULT 'stock';
DROP TYPE "public"."ImageStatus";
DROP TYPE "public"."ImageRenderStatus";
DROP TYPE "public"."ImageStorageStatus";
DROP TYPE "public"."InventoryPlacement";
ALTER TABLE "Image" ADD CONSTRAINT "Image_status_check"
  CHECK ("Image"."status" IN ('PENDING', 'UPLOADED', 'FAILED'));
ALTER TABLE "Image" ADD CONSTRAINT "Image_renderStatus_check"
  CHECK ("Image"."renderStatus" IN ('unverified', 'verified', 'failed'));
ALTER TABLE "Image" ADD CONSTRAINT "Image_storageStatus_check"
  CHECK ("Image"."storageStatus" IN ('unverified', 'available', 'missing', 'metadata_mismatch'));
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_placement_check"
  CHECK ("InventoryEntry"."placement" IN ('stock', 'installed'));

-- ---------------------------------------------------------------------------
-- Location.aiDescription -> AiAnalysis('location-description'); Location.type
-- ---------------------------------------------------------------------------
-- A description whose analysis row is missing keeps showing: it becomes a
-- legacy AiAnalysis dated at the location's last update, so any real analysis
-- run later is newer and wins.
INSERT INTO "AiAnalysis"
  ("entityKind", "entityId", "feature", "model", "promptVersion",
   "inputFingerprint", "result", "createdAt", "updatedAt")
SELECT 'location', l.id, 'location-description', 'legacy-column', 'legacy-column',
       'legacy:' || l.id::text,
       jsonb_build_object('description', l."aiDescription", 'confidence', 'low'),
       l."updatedAt", l."updatedAt"
FROM "Location" l
WHERE l."aiDescription" IS NOT NULL AND btrim(l."aiDescription") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "AiAnalysis" a
    WHERE a."entityKind" = 'location' AND a."entityId" = l.id
      AND a.feature = 'location-description' AND a."deletedAt" IS NULL
  );
-- A NULL column meant "no description" (every image was removed): keep that
-- state visible by retiring the analyses the column no longer points at.
UPDATE "AiAnalysis" a SET "deletedAt" = now()
FROM "Location" l
WHERE a."entityKind" = 'location' AND a."entityId" = l.id
  AND a.feature = 'location-description' AND a."deletedAt" IS NULL
  AND (l."aiDescription" IS NULL OR btrim(l."aiDescription") = '');
ALTER TABLE "Location" DROP COLUMN "aiDescription";

UPDATE "Location" SET type = 'furniture' WHERE type IS NULL;
ALTER TABLE "Location" ALTER COLUMN "type" SET NOT NULL;
ALTER TABLE "Location" ADD CONSTRAINT "Location_furniture_product_check"
  CHECK ("Location"."type" <> 'furniture' OR "Location"."productId" IS NOT NULL);
-- The "type is not recorded" check can no longer fire.
DELETE FROM "DataException" WHERE "check" = 'location_type';

-- ---------------------------------------------------------------------------
-- VendorAccount.lastRunAt/lastSuccessAt (read from Run) and
-- Cookbook.sourceRecipeCount (read from the stored extraction)
-- ---------------------------------------------------------------------------
ALTER TABLE "VendorAccount"
  DROP COLUMN "lastRunAt",
  DROP COLUMN "lastSuccessAt";
ALTER TABLE "Cookbook" DROP COLUMN "sourceRecipeCount";

-- ---------------------------------------------------------------------------
-- Naming: GardenEntry.note -> notes; Recipe.tags NOT NULL DEFAULT '{}'
-- ---------------------------------------------------------------------------
ALTER TABLE "GardenEntry" RENAME COLUMN "note" TO "notes";
UPDATE "Recipe" SET tags = '{}'::text[] WHERE tags IS NULL;
ALTER TABLE "Recipe" ALTER COLUMN "tags" SET DEFAULT '{}'::text[];
ALTER TABLE "Recipe" ALTER COLUMN "tags" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Redundant indexes: each leading column is covered by a composite
-- (Product_name_manufacturer_idx, Location_type_name_idx,
-- StatementRow_account_date_amount_idx, ImageProcessingJob_identity_key)
-- ---------------------------------------------------------------------------
DROP INDEX "Product_name_idx";
DROP INDEX "Location_type_idx";
DROP INDEX "StatementRow_accountId_idx";
DROP INDEX "ImageProcessingJob_image_idx";

-- ---------------------------------------------------------------------------
-- Relative post-checks against the pre-snapshot
-- ---------------------------------------------------------------------------
DO $$
DECLARE bad bigint; r record;
BEGIN
  FOR r IN SELECT k, n FROM "_shape_pre" WHERE k IN
    ('InventoryEntry', 'ProductUnitMappings', 'MealFoodEntry', 'MealRecipePortion',
     'Location', 'Cookbook', 'VendorAccount', 'GardenEntry', 'Recipe', 'Image')
  LOOP
    EXECUTE format('SELECT count(*) FROM %I', CASE r.k WHEN 'ProductUnitMappings' THEN 'ProductUnitMapping' ELSE r.k END)
      INTO bad;
    IF bad <> r.n THEN
      RAISE EXCEPTION 'shape: % row count changed % -> %', r.k, r.n, bad;
    END IF;
  END LOOP;

  -- Amounts preserved: per-unit row count and value sum (float8 -> numeric
  -- rounds to 15 digits, so compare with a tolerance).
  SELECT count(*) INTO bad FROM (
    SELECT 'inv:' || "amountUnit" AS k, count(*) AS n, sum("amountValue"::numeric) AS v
      FROM "InventoryEntry" GROUP BY "amountUnit"
    UNION ALL SELECT 'unitmap:a:' || "aUnit", count(*), sum("aValue"::numeric)
      FROM "ProductUnitMapping" GROUP BY "aUnit"
    UNION ALL SELECT 'unitmap:b:' || "bUnit", count(*), sum("bValue"::numeric)
      FROM "ProductUnitMapping" GROUP BY "bUnit"
    UNION ALL SELECT 'food:' || "amountUnit", count(*), sum("amountValue"::numeric)
      FROM "MealFoodEntry" WHERE "amountUnit" IS NOT NULL GROUP BY "amountUnit"
    UNION ALL SELECT 'portion:' || "amountUnit", count(*), sum("amountValue"::numeric)
      FROM "MealRecipePortion" GROUP BY "amountUnit"
  ) post
  FULL JOIN (SELECT k, n, v FROM "_shape_pre" WHERE v IS NOT NULL) pre USING (k)
  WHERE post.n IS DISTINCT FROM pre.n
     OR abs(coalesce(post.v, 0) - coalesce(pre.v, 0)) > 1e-6;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % amount groups changed by the reshape', bad; END IF;

  -- Every location that carried a description still has a live analysis.
  SELECT count(*) INTO bad FROM "Location" l
    WHERE NOT EXISTS (
      SELECT 1 FROM "AiAnalysis" a
      WHERE a."entityKind" = 'location' AND a."entityId" = l.id
        AND a.feature = 'location-description' AND a."deletedAt" IS NULL)
      AND l.id IN (SELECT DISTINCT a2."entityId" FROM "AiAnalysis" a2
        WHERE a2.model = 'legacy-column');
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % backfilled descriptions are not live', bad; END IF;
  SELECT count(*) INTO bad FROM (
    SELECT DISTINCT "entityId" FROM "AiAnalysis"
    WHERE "entityKind" = 'location' AND feature = 'location-description' AND "deletedAt" IS NULL
  ) live;
  IF bad < (SELECT n FROM "_shape_pre" WHERE k = 'aidesc:live_location_with_description') THEN
    RAISE EXCEPTION 'shape: % locations have a live description analysis, expected at least %',
      bad, (SELECT n FROM "_shape_pre" WHERE k = 'aidesc:live_location_with_description');
  END IF;

  SELECT count(*) INTO bad FROM "Location" WHERE type IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'shape: % locations still have no type', bad; END IF;
END $$;
--> statement-breakpoint
-- transform/60-runs.sql
-- Runs: one Run per (actor, channel, hour) of throwaway AI work, the legacy
-- Run relabelled, the Gmail search job folded into its Run, and RunMutation
-- folded into AuditLog. Plain Postgres DDL and backfills, no BEGIN/COMMIT: the
-- caller runs every transform fragment in one transaction. Names match what
-- Drizzle emits for apps/web/src/server/db/schema.ts. Every check below is
-- relative to a snapshot taken here, so it also passes on an empty database.

CREATE TEMP TABLE "_runs_pre" ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM "AiUsage") AS "aiUsage",
  (SELECT count(*) FROM "AuditLog") AS "auditLog",
  (SELECT count(*) FROM "RunMutation" WHERE "auditLogId" IS NULL) AS "unmirrored",
  (SELECT count(*) FROM "VendorMailSearchJob") AS "mailJobs",
  (SELECT count(*) FROM "Run" WHERE "purpose" = 'legacy') AS "legacyRuns",
  (SELECT count(*) FROM "Entity" WHERE "kind" = 'run') AS "runEntities";

-- ---------------------------------------------------------------------------
-- Run: input / progress, and the purpose check without ai_action / legacy
-- ---------------------------------------------------------------------------
ALTER TABLE "Run" ADD COLUMN "input" jsonb;
ALTER TABLE "Run" ADD COLUMN "progress" jsonb;
ALTER TABLE "Run" DROP CONSTRAINT "Run_purpose_check";

-- ---------------------------------------------------------------------------
-- ai_action -> one ai_suggest keeper per (actor, channel, UTC hour)
-- ---------------------------------------------------------------------------
-- The group key is the clientKey `aiCallRunInput` computes for the same call
-- (`<channel>:<userId>:<hour>`, no user for the system channel), so a call in
-- an already-migrated hour joins its keeper.
CREATE TEMP TABLE "_runs_ai_action" ON COMMIT DROP AS
SELECT
  k."id",
  -- Partition by the key itself: the system channel omits the actor, so
  -- partitioning by actor could give two keepers the same unique clientKey.
  first_value(k."id") OVER (
    PARTITION BY k."clientKey" ORDER BY k."startedAt", k."id"
  ) AS "keeperId",
  k."clientKey"
FROM (
  SELECT
    r."id",
    r."startedAt",
    r."channel" || ':'
      || CASE WHEN r."channel" = 'system' THEN '' ELSE r."actorUserId" || ':' END
      || to_char(date_trunc('hour', r."startedAt"), 'YYYY-MM-DD"T"HH24') AS "clientKey"
  FROM "Run" r
  WHERE r."purpose" = 'ai_action'
) k;

-- Point every single-column reference to a run being merged at its keeper
-- (AiUsage.runId has no ON DELETE; AuditLog.runId would silently null).
DO $$
DECLARE
  fk record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'f' AND confrelid = '"Run"'::regclass
      AND array_length(conkey, 1) <> 1
  ) THEN
    RAISE EXCEPTION 'A composite foreign key references "Run"; repoint it explicitly';
  END IF;
  FOR fk IN
    SELECT c.conrelid::regclass::text AS "tbl", a.attname AS "col"
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.confrelid = '"Run"'::regclass
  LOOP
    EXECUTE format(
      'UPDATE %s AS t SET %I = g."keeperId" FROM "_runs_ai_action" AS g '
      'WHERE t.%I = g."id" AND g."id" <> g."keeperId"',
      fk.tbl, fk.col, fk.col
    );
  END LOOP;
END $$;

UPDATE "Run" AS k
SET "purpose" = 'ai_suggest',
    "clientKey" = agg."clientKey",
    "startedAt" = agg."firstStart",
    "endedAt" = agg."lastEnd"
FROM (
  SELECT g."keeperId", g."clientKey",
         min(r."startedAt") AS "firstStart", max(r."endedAt") AS "lastEnd"
  FROM "_runs_ai_action" g
  JOIN "Run" r ON r."id" = g."id"
  GROUP BY g."keeperId", g."clientKey"
) AS agg
WHERE k."id" = agg."keeperId";

CREATE TEMP TABLE "_runs_dropped" ON COMMIT DROP AS
SELECT "id" FROM "_runs_ai_action" WHERE "id" <> "keeperId";

DELETE FROM "Run" WHERE "id" IN (SELECT "id" FROM "_runs_dropped");

-- The identity trigger tombstones a hard-deleted payload's Entity row; these
-- rows never named anything a person can open, so they go too. Any surviving
-- reference to one fails this DELETE (composite FKs to Entity) and rolls the
-- migration back.
DELETE FROM "Entity"
WHERE "kind" = 'run' AND "id" IN (SELECT "id" FROM "_runs_dropped");

-- ---------------------------------------------------------------------------
-- The legacy Run keeps its usage as ordinary background work
-- ---------------------------------------------------------------------------
UPDATE "Run"
SET "purpose" = 'background', "notes" = 'pre-Run AI usage'
WHERE "purpose" = 'legacy';

-- ---------------------------------------------------------------------------
-- VendorMailSearchJob -> Run.input / Run.progress
-- ---------------------------------------------------------------------------
-- `phase` carries the job's status (the claim state); a rate-limited page's
-- transient error stays in progress, a failed job's error becomes the Run's
-- failure details. `updatedAt` is copied because stale-page recovery reads it.
UPDATE "Run" AS r
SET "purpose" = 'mail_search',
    "input" = jsonb_build_object(
      'after', j."after",
      'searchTerms', to_jsonb(j."searchTerms")
    ),
    "progress" = jsonb_build_object(
      'phase', j."status",
      'pageToken', j."pageToken",
      'nextPageToken', j."nextPageToken",
      'pagesScanned', j."pagesScanned",
      'searched', j."searched",
      'reviewable', j."reviewable"
    ) || CASE
      WHEN j."status" <> 'failed' AND j."error" IS NOT NULL
        THEN jsonb_build_object('error', j."error")
      ELSE '{}'::jsonb
    END,
    "skipped" = j."skipped",
    "dispatchError" = COALESCE(
      r."dispatchError",
      CASE WHEN j."status" = 'failed' THEN j."error" END
    ),
    "updatedAt" = j."updatedAt"
FROM "VendorMailSearchJob" AS j
WHERE j."runId" = r."id";

ALTER TABLE "Run" ADD CONSTRAINT "Run_purpose_check"
  CHECK ("Run"."purpose" IN ('account_sync', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'background', 'file_import', 'mail_search'));

DROP TABLE "VendorMailSearchJob";

-- ---------------------------------------------------------------------------
-- RunMutation -> AuditLog (carrying the Run's id)
-- ---------------------------------------------------------------------------
-- A mutation that already names its AuditLog row keeps that row; the row learns
-- its Run if it did not carry one. Every other mutation becomes an audit row:
-- the mutation kinds the audit trail cannot express (attach, skip) are
-- updates, and the touched fields are named without values, as the writers do.
UPDATE "AuditLog" AS a
SET "runId" = m."runId"
FROM "RunMutation" AS m
WHERE a."id" = m."auditLogId" AND a."runId" IS NULL;

INSERT INTO "AuditLog" (
  "id", "entityKind", "entityId", "action", "changes", "userId", "channel",
  "oauthClientId", "deviceId", "runId", "createdAt"
)
SELECT
  gen_random_uuid(),
  m."targetKind",
  m."targetId",
  CASE m."mutationKind"
    WHEN 'create' THEN 'create'
    WHEN 'delete' THEN 'delete'
    ELSE 'update'
  END,
  COALESCE(
    (
      SELECT jsonb_object_agg(f."field", jsonb_build_object('from', NULL::jsonb, 'to', NULL::jsonb))
      FROM jsonb_array_elements_text(m."fields") AS f("field")
    ),
    '{}'::jsonb
  ),
  r."actorUserId",
  r."channel",
  r."oauthClientId",
  CASE WHEN EXISTS (SELECT 1 FROM "Device" d WHERE d."id" = r."deviceId")
    THEN r."deviceId" END,
  m."runId",
  m."createdAt"
FROM "RunMutation" AS m
JOIN "Run" AS r ON r."id" = m."runId"
WHERE m."auditLogId" IS NULL;

DROP INDEX "AuditLog_runId_idx";
CREATE INDEX "AuditLog_runId_entityKind_idx" ON "AuditLog" USING btree ("runId","entityKind") WHERE "AuditLog"."runId" IS NOT NULL;

DROP TABLE "RunMutation";

-- ---------------------------------------------------------------------------
-- Relative post-checks
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pre record;
BEGIN
  SELECT * INTO pre FROM "_runs_pre";
  IF (SELECT count(*) FROM "AiUsage") <> pre."aiUsage" THEN
    RAISE EXCEPTION 'AiUsage row count changed during run consolidation';
  END IF;
  IF (SELECT count(*) FROM "AuditLog") <> pre."auditLog" + pre."unmirrored" THEN
    RAISE EXCEPTION 'AuditLog did not grow by exactly the unmirrored RunMutation rows';
  END IF;
  IF (SELECT count(*) FROM "Run" WHERE "purpose" = 'mail_search') <> pre."mailJobs" THEN
    RAISE EXCEPTION 'Every VendorMailSearchJob must become one mail_search Run';
  END IF;
  IF (SELECT count(*) FROM "Run" WHERE "purpose" = 'background' AND "notes" = 'pre-Run AI usage') < pre."legacyRuns" THEN
    RAISE EXCEPTION 'A legacy Run was not relabelled';
  END IF;
  IF (SELECT count(*) FROM "Entity" WHERE "kind" = 'run')
       <> pre."runEntities" - (SELECT count(*) FROM "_runs_dropped") THEN
    RAISE EXCEPTION 'Entity rows for consolidated runs were not deleted (or others were)';
  END IF;
  IF EXISTS (SELECT 1 FROM "AiUsage" u LEFT JOIN "Run" r ON r."id" = u."runId" WHERE r."id" IS NULL) THEN
    RAISE EXCEPTION 'AiUsage names a Run that no longer exists';
  END IF;
END $$;
--> statement-breakpoint
-- transform/70-order-mail-blob.sql
-- OrderMailAttachment: pending attachment bytes move from a base64 text column
-- to object storage. `apps/web/scripts/order-mail-attachments-to-r2.ts` uploads
-- each row's bytes to `order-mail-attachment/<id>` and verifies the readback
-- BEFORE this runs; this fragment records the deterministic key and drops the
-- only other copy. Plain DDL/backfill, no BEGIN/COMMIT (one transaction with
-- the other fragments). Trivially passes on an empty database.

ALTER TABLE "OrderMailAttachment" ADD COLUMN "pendingObjectKey" text;

UPDATE "OrderMailAttachment"
  SET "pendingObjectKey" = 'order-mail-attachment/' || "id"
  WHERE "pendingDataBase64Url" IS NOT NULL;

-- Relative check: every row that had bytes now has a key, and no other row does.
DO $$
DECLARE
  had_bytes bigint;
  has_key bigint;
BEGIN
  SELECT count("pendingDataBase64Url"), count("pendingObjectKey")
    INTO had_bytes, has_key
    FROM "OrderMailAttachment";
  IF had_bytes <> has_key THEN
    RAISE EXCEPTION
      'OrderMailAttachment: % rows had base64 bytes but % rows have an object key',
      had_bytes, has_key;
  END IF;
END $$;

ALTER TABLE "OrderMailAttachment" DROP COLUMN "pendingDataBase64Url";
--> statement-breakpoint
-- transform/90-post-check.sql
-- Post-check: every global invariant snapshotted by 00-guard must hold after
-- all slices ran. Slice-specific checks live at the end of each fragment.
DO $$
DECLARE
  drift text;
BEGIN
  -- All money lives on Expense: spend per month, live and deleted, is untouched.
  SELECT string_agg(coalesce(pre."month", post."month")::text, ', ')
  INTO drift
  FROM "_cleanup_pre_money" pre
  FULL JOIN (
    SELECT coalesce(date_trunc('month', "date"), '-infinity') AS "month", ("deletedAt" IS NULL) AS "live",
      count(*) AS "lines", coalesce(sum("cost"::numeric), 0) AS "cost"
    FROM "Expense" GROUP BY 1, 2
  ) post USING ("month", "live")
  WHERE pre."lines" IS DISTINCT FROM post."lines"
     OR pre."cost" IS DISTINCT FROM post."cost";
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'cleanup changed Expense spend for months: %', drift;
  END IF;

  -- Tables no slice may add or remove rows from.
  SELECT string_agg(pre."table" || ' ' || pre."rows" || '->' || post."rows", ', ')
  INTO drift
  FROM "_cleanup_pre_counts" pre
  JOIN (
    SELECT 'Expense' AS "table", count(*) AS "rows" FROM "Expense"
    UNION ALL SELECT 'Purchase', count(*) FROM "Purchase"
    UNION ALL SELECT 'Vendor', count(*) FROM "Vendor"
    UNION ALL SELECT 'FinancialAccount', count(*) FROM "FinancialAccount"
    UNION ALL SELECT 'FinancialTransaction', count(*) FROM "FinancialTransaction"
    UNION ALL SELECT 'FinancialTransactionAllocation', count(*) FROM "FinancialTransactionAllocation"
    UNION ALL SELECT 'StatementRow', count(*) FROM "StatementRow"
    UNION ALL SELECT 'Product', count(*) FROM "Product"
    UNION ALL SELECT 'Ingredient', count(*) FROM "Ingredient"
    UNION ALL SELECT 'Recipe', count(*) FROM "Recipe"
    UNION ALL SELECT 'RecipeSectionIngredient', count(*) FROM "RecipeSectionIngredient"
    UNION ALL SELECT 'Location', count(*) FROM "Location"
    UNION ALL SELECT 'InventoryEntry', count(*) FROM "InventoryEntry"
    UNION ALL SELECT 'Project', count(*) FROM "Project"
    UNION ALL SELECT 'Task', count(*) FROM "Task"
    UNION ALL SELECT 'Image', count(*) FROM "Image"
    UNION ALL SELECT 'EntityAttachment', count(*) FROM "EntityAttachment"
    UNION ALL SELECT 'AiUsage', count(*) FROM "AiUsage"
  ) post USING ("table")
  WHERE pre."rows" <> post."rows";
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'cleanup changed row counts: %', drift;
  END IF;

  -- Entity identities change only for the two kinds the cleanup retires rows
  -- of: imageSighting (demoted) and run (throwaway AI runs consolidated).
  SELECT string_agg(coalesce(pre."kind", post."kind"), ', ')
  INTO drift
  FROM "_cleanup_pre_entities" pre
  FULL JOIN (
    SELECT "kind", count(*) AS "rows", count(*) FILTER (WHERE "deletedAt" IS NULL) AS "live"
    FROM "Entity" GROUP BY 1
  ) post USING ("kind")
  WHERE coalesce(pre."kind", post."kind") NOT IN ('imageSighting', 'run')
    AND (pre."rows" IS DISTINCT FROM post."rows" OR pre."live" IS DISTINCT FROM post."live");
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'cleanup changed Entity identities for kinds: %', drift;
  END IF;

  -- Every constraint the transform added or re-added is validated.
  SELECT string_agg(conrelid::regclass || '.' || conname, ', ')
  INTO drift
  FROM pg_constraint
  WHERE NOT convalidated AND connamespace = 'public'::regnamespace;
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'cleanup left unvalidated constraints: %', drift;
  END IF;
END $$;
