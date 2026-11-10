DROP TABLE "AutomaticRule";--> statement-breakpoint
ALTER TABLE "AuditLog" ADD COLUMN "authority" text;--> statement-breakpoint
ALTER TABLE "AuditLog" ADD COLUMN "automationPending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "AuditLog_automationPending_idx" ON "AuditLog" ("createdAt","id") WHERE "automationPending";--> statement-breakpoint
CREATE INDEX "AuditLog_automatic_createdAt_idx" ON "AuditLog" ("createdAt" DESC NULLS LAST) WHERE "authority" = 'automatic';--> statement-breakpoint
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_authority_check" CHECK ("authority" IN ('automatic', 'released'));--> statement-breakpoint
ALTER TABLE "ProductCategory" DROP CONSTRAINT "ProductCategory_feature_check", ADD CONSTRAINT "ProductCategory_feature_check" CHECK ("feature" IS NULL OR "feature" IN ('food', 'books', 'music', 'tools', 'tool-consumables', 'tool-accessories', 'storage', 'hardware', 'electronics', 'software', 'services', 'household', 'supplies', 'apparel', 'planting'));--> statement-breakpoint
-- AutomaticRule held each rule's switch history; the rules are fixed code and
-- nothing read the table. The owner authorized the drop with no archive.
-- Backfill: an audit row is Cubby's own write exactly when an automatic field
-- application receipt lists it. Every other existing value stays protected.
UPDATE "AuditLog" a SET "authority" = 'automatic'
FROM "Suggestion" s
WHERE s."family" = 'field'
  AND s."acceptanceReceipt"->>'mode' = 'automatic'
  AND s."acceptanceReceipt"->'auditIds' ? a."id"::text
  AND a."entityKind" = s."entity"
  AND a."entityId" = s."recordId"
  AND a."action" = 'update'
  AND a."changes" ? s."field";--> statement-breakpoint
-- task.subjectProductId is no longer suggested: retire its open guesses. Field
-- rows stay, since evaluations and decisions name them by id.
UPDATE "Suggestion" SET "status" = 'superseded', "active" = false
WHERE "family" = 'field' AND "entity" = 'task' AND "field" = 'subjectProductId'
  AND "status" = 'pending';
