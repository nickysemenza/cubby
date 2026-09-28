-- Composed by tooling/db-compose-migration.ts from drizzle/transform/.
-- transform/00-guard.sql
-- Guard: snapshot the invariants the whole cleanup must preserve, before any
-- slice runs. Everything here is relative (compared again in 90-post-check),
-- so it holds on an empty test database and on production alike. Absolute
-- production expectations live in the external verification script.
CREATE TEMP TABLE "_cleanup_pre_money" ON COMMIT DROP AS
SELECT
  date_trunc('month', "date") AS "month",
  ("deletedAt" IS NULL) AS "live",
  count(*) AS "lines",
  coalesce(sum("cost"), 0) AS "cost"
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
    SELECT date_trunc('month', "date") AS "month", ("deletedAt" IS NULL) AS "live",
      count(*) AS "lines", coalesce(sum("cost"), 0) AS "cost"
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
