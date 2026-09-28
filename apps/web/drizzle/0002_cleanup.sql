-- Composed by tooling/db-compose-migration.ts from drizzle/transform/.
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
