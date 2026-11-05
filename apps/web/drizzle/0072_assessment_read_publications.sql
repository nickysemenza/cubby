CREATE TABLE "AssessmentReadDependency" (
	"assessmentId" uuid NOT NULL,
	"sourceKind" text NOT NULL,
	"sourceId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AssessmentReadMembership" (
	"assessmentId" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"entity" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"stateFamily" text NOT NULL,
	"retained" boolean NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "AssessmentReadMembership_kind_check" CHECK ("AssessmentReadMembership"."kind" IN ('scope', 'ref')),
	CONSTRAINT "AssessmentReadMembership_ordinal_check" CHECK ("AssessmentReadMembership"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "AssessmentReadPublication" (
	"assessmentId" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"family" text,
	"active" boolean DEFAULT false NOT NULL,
	"rulesVersion" integer NOT NULL,
	"contentHash" text NOT NULL,
	"groupKey" text NOT NULL,
	"admitted" boolean NOT NULL,
	"computedAt" timestamp NOT NULL,
	"clockDay" date,
	"key" jsonb,
	"filters" jsonb,
	"row" jsonb,
	"dependencies" jsonb NOT NULL,
	CONSTRAINT "AssessmentReadPublication_result_check" CHECK (("AssessmentReadPublication"."admitted" AND "AssessmentReadPublication"."family" IS NOT NULL AND "AssessmentReadPublication"."key" IS NOT NULL AND "AssessmentReadPublication"."filters" IS NOT NULL AND "AssessmentReadPublication"."row" IS NOT NULL) OR (NOT "AssessmentReadPublication"."admitted" AND "AssessmentReadPublication"."family" IS NULL AND "AssessmentReadPublication"."key" IS NULL AND "AssessmentReadPublication"."filters" IS NULL AND "AssessmentReadPublication"."row" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "AssessmentReadStage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"componentKey" text NOT NULL,
	"groups" jsonb NOT NULL,
	"assessmentIds" uuid[] NOT NULL,
	"tickets" jsonb NOT NULL,
	"revision" uuid NOT NULL,
	"nextIndex" integer DEFAULT 0 NOT NULL,
	"rulesVersion" integer NOT NULL,
	"clockDay" date,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "AssessmentReadStage_progress_check" CHECK (cardinality("AssessmentReadStage"."assessmentIds") > 0 AND "AssessmentReadStage"."nextIndex" >= 0 AND "AssessmentReadStage"."nextIndex" <= cardinality("AssessmentReadStage"."assessmentIds"))
);
--> statement-breakpoint
ALTER TABLE "WorkItem" ADD COLUMN "fanoutAfter" uuid;--> statement-breakpoint
ALTER TABLE "AssessmentReadDependency" ADD CONSTRAINT "AssessmentReadDependency_assessmentId_Assessment_id_fk" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AssessmentReadMembership" ADD CONSTRAINT "AssessmentReadMembership_assessmentId_Assessment_id_fk" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AssessmentReadPublication" ADD CONSTRAINT "AssessmentReadPublication_assessmentId_Assessment_id_fk" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadDependency_source_key" ON "AssessmentReadDependency" USING btree ("assessmentId","sourceKind","sourceId");--> statement-breakpoint
CREATE INDEX "AssessmentReadDependency_reverse_idx" ON "AssessmentReadDependency" USING btree ("sourceId","sourceKind","assessmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadMembership_revision_ordinal_key" ON "AssessmentReadMembership" USING btree ("assessmentId","revision","kind","ordinal");--> statement-breakpoint
CREATE INDEX "AssessmentReadMembership_entity_idx" ON "AssessmentReadMembership" USING btree ("kind","entity","assessmentId","revision");--> statement-breakpoint
CREATE INDEX "AssessmentReadMembership_value_idx" ON "AssessmentReadMembership" USING btree ("kind",md5("value"),"assessmentId","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadPublication_revision_family_key" ON "AssessmentReadPublication" USING btree ("assessmentId","revision",coalesce("family", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadPublication_active_family_key" ON "AssessmentReadPublication" USING btree ("assessmentId",coalesce("family", '')) WHERE "AssessmentReadPublication"."active";--> statement-breakpoint
CREATE INDEX "AssessmentReadPublication_family_idx" ON "AssessmentReadPublication" USING btree ("family","assessmentId") WHERE "AssessmentReadPublication"."active";--> statement-breakpoint
CREATE INDEX "AssessmentReadPublication_group_idx" ON "AssessmentReadPublication" USING btree ("groupKey","assessmentId") WHERE "AssessmentReadPublication"."active";--> statement-breakpoint
CREATE INDEX "AssessmentReadPublication_rules_idx" ON "AssessmentReadPublication" USING btree ("rulesVersion") WHERE "AssessmentReadPublication"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadStage_component_key" ON "AssessmentReadStage" USING btree ("componentKey");--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadStage_revision_key" ON "AssessmentReadStage" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "AssessmentState_active_suppression_idx" ON "AssessmentState" USING btree ("entity","recordId") WHERE "AssessmentState"."active" AND "AssessmentState"."suppression" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark(p_target text, p_refs uuid[], p_reason text DEFAULT 'Refresh requested') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "WorkItem" (target, ref, priority, reason)
    SELECT DISTINCT p_target, r,
      CASE current_setting('cubby.derived_priority', true) WHEN '1' THEN 1 ELSE 0 END, p_reason
    FROM unnest(p_refs) AS r WHERE r IS NOT NULL
  ON CONFLICT (target, ref) DO UPDATE SET
    reason = EXCLUDED.reason,
    ticket = nextval('"WorkTicket"'),
    priority = LEAST("WorkItem".priority, EXCLUDED.priority),
    "readyAt" = now(),
    attempts = 0,
    "lastError" = NULL,
    "waitCause" = NULL,
    "waitStartedAt" = NULL,
    "fanoutAfter" = NULL;
  IF current_setting('cubby.derived_capture', true) IS DISTINCT FROM txid_current()::text THEN
    INSERT INTO "JobInvalidationCapture" (key, "capturedAt")
      VALUES ('derived:drain', now() AT TIME ZONE 'UTC');
    PERFORM set_config('cubby.derived_capture', txid_current()::text, true);
  END IF;
END $$;

--> statement-breakpoint
-- Initial publication coverage uses the same open population as the reader.
-- Apply after the matching Worker is serving: predecessor drains do not own
-- this target. Existing tickets and retry state must survive enrollment.
WITH seeded AS (
  INSERT INTO "WorkItem" (target, ref, priority, reason)
  SELECT 'assessment.reviewFacts', s.id, 2, 'Initial Assessment publication'
  FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id
  WHERE s.active AND s.status = 'pending'
    AND (s.family IN ('field', 'recommendation', 'product_pair', 'image_description', 'statement_transaction', 'transfer_pair')
      OR a.family IN ('field', 'recommendation', 'product_pair', 'image_description', 'statement_transaction', 'transfer_pair'))
    AND (a.served OR s.family IN ('statement_transaction', 'transfer_pair'))
  ORDER BY s.id
  ON CONFLICT (target, ref) DO NOTHING
  RETURNING 1
)
INSERT INTO "JobInvalidationCapture" (key, "capturedAt")
  SELECT 'derived:drain', now() AT TIME ZONE 'UTC' WHERE EXISTS (SELECT 1 FROM seeded);
--> statement-breakpoint
-- Assessment publication capture registration.
CREATE OR REPLACE FUNCTION derived_mark_aianalysis() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('product.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('product.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('recipe.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('recipe.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('ingredient.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('ingredient.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('cookbook.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('cookbook.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('location.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('location.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' AND NEW."feature" = 'location-description' THEN PERFORM derived_mark('location.searchDocument', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' AND OLD."feature" = 'location-description' THEN PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'location' AND OLD."feature" = 'location-description' OR NEW."entityKind" = 'location' AND NEW."feature" = 'location-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' AND NEW."feature" = 'location-description' THEN PERFORM derived_mark('location.dataQuality', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' AND OLD."feature" = 'location-description' THEN PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'location' AND OLD."feature" = 'location-description' OR NEW."entityKind" = 'location' AND NEW."feature" = 'location-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('inventory.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('inventory.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('meal.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('meal.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@0', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@0', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ai analysis removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@0', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('project.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('project.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('task.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('task.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('vendor.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('vendor.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('purchase.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('purchase.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('financialAccount.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('financialAccount.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('financialTransaction.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('financialTransaction.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('wish.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('wish.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('expense.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('expense.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('planting.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('planting.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('gardenEntry.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('gardenEntry.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('plant.searchDocument@3', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('plant.searchDocument@3', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@3', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' AND NEW."feature" = 'image-description' THEN PERFORM derived_mark('assessment.reviewFacts@106', ARRAY[NEW."entityId"::uuid], 'Ai analysis created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' THEN PERFORM derived_mark('assessment.reviewFacts@106', ARRAY[OLD."entityId"::uuid], 'Ai analysis removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' AND OLD."feature" = 'image-description' OR NEW."entityKind" = 'image' AND NEW."feature" = 'image-description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@106', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Ai analysis changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_assessment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@1', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@1', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@1', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument@4', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument@4', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument@4', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@5', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'email_relevance' THEN PERFORM derived_mark('email.dataQuality@13', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'email_relevance' THEN PERFORM derived_mark('email.dataQuality@13', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'email_relevance' OR NEW."family" = 'email_relevance') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@13', ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."subject")) = 'array' THEN jsonb_build_array(OLD."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'recordId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."subject")) = 'array' THEN jsonb_build_array(NEW."subject") ELSE '[]'::jsonb END) AS e WHERE e->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'field' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'field' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'field' OR NEW."family" = 'field') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'recommendation' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'recommendation' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'recommendation' OR NEW."family" = 'recommendation') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'product_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'product_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'product_pair' OR NEW."family" = 'product_pair') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'statement_transaction' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'statement_transaction' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'statement_transaction' OR NEW."family" = 'statement_transaction') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'transfer_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'transfer_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (OLD."family" = 'transfer_pair' OR NEW."family" = 'transfer_pair') AND (OLD."id", OLD."served", OLD."family") IS DISTINCT FROM (NEW."id", NEW."served", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@175', ARRAY[NEW."id"::uuid], 'Assessment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@175', ARRAY[OLD."id"::uuid], 'Assessment removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."served") IS DISTINCT FROM (NEW."id", NEW."served") THEN
    PERFORM derived_mark('assessment.reviewFacts@175', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_assessmentstate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment state removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'email_link' THEN PERFORM derived_mark('purchase.dataQuality@11', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'email_link' THEN PERFORM derived_mark('purchase.dataQuality@11', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'email_link' OR NEW."family" = 'email_link') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@11', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entity" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entity" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."entity" = 'purchase' OR NEW."entity" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'email_link' THEN PERFORM derived_mark('expense.beneficiaryResult@8', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'email_link' THEN PERFORM derived_mark('expense.beneficiaryResult@8', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'email_link' OR NEW."family" = 'email_link') AND (OLD."data", OLD."active", OLD."family") IS DISTINCT FROM (NEW."data", NEW."active", NEW."family") THEN
    PERFORM derived_mark('expense.beneficiaryResult@8', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'email_link' THEN PERFORM derived_mark('email.relationshipFacts@4', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'email_link' THEN PERFORM derived_mark('email.relationshipFacts@4', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'email_link' OR NEW."family" = 'email_link') AND (OLD."data", OLD."active", OLD."family") IS DISTINCT FROM (NEW."data", NEW."active", NEW."family") THEN
    PERFORM derived_mark('email.relationshipFacts@4', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'email_link' THEN PERFORM derived_mark('email.dataQuality@6', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'email_link' THEN PERFORM derived_mark('email.dataQuality@6', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'email_link' OR NEW."family" = 'email_link') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@6', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'field' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'field' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'field' OR NEW."family" = 'field') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'recommendation' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'recommendation' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'recommendation' OR NEW."family" = 'recommendation') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'product_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'product_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'product_pair' OR NEW."family" = 'product_pair') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'statement_transaction' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'statement_transaction' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'statement_transaction' OR NEW."family" = 'statement_transaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'transfer_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'transfer_pair' THEN PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'transfer_pair' OR NEW."family" = 'transfer_pair') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts@107', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('assessment.reviewFacts@107', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@107', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'email_link' THEN PERFORM derived_mark('assessment.reviewFacts@163', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'email_link' THEN PERFORM derived_mark('assessment.reviewFacts@163', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'email_link' OR NEW."family" = 'email_link') AND (OLD."data", OLD."active", OLD."family") IS DISTINCT FROM (NEW."data", NEW."active", NEW."family") THEN
    PERFORM derived_mark('assessment.reviewFacts@163', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'field' AND NEW."entity" = 'financialAccount' THEN PERFORM derived_mark('assessment.reviewFacts@170', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'field' AND OLD."entity" = 'financialAccount' THEN PERFORM derived_mark('assessment.reviewFacts@170', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'field' AND OLD."entity" = 'financialAccount' OR NEW."family" = 'field' AND NEW."entity" = 'financialAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@170', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@176', ARRAY[NEW."id"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@176', ARRAY[OLD."id"::uuid], 'Assessment state removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@176', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Assessment state changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_auditlog() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."action" = 'update' THEN PERFORM derived_mark('assessment.reviewFacts@102', ARRAY[NEW."entityId"::uuid], 'Audit log created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."action" = 'update' THEN PERFORM derived_mark('assessment.reviewFacts@102', ARRAY[OLD."entityId"::uuid], 'Audit log removed'); END IF;
  ELSIF (OLD."action" = 'update' OR NEW."action" = 'update') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@102', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Audit log changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "AuditLog_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_auditlog();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_cookbook() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Cookbook created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Cookbook removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Cookbook changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[NEW."id"::uuid], 'Cookbook created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."id"::uuid], 'Cookbook removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Cookbook changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[NEW."id"::uuid], 'Cookbook created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."id"::uuid], 'Cookbook removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Cookbook changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@3', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Cookbook created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@3', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Cookbook removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@3', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Cookbook changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@27', ARRAY[NEW."id"::uuid], 'Cookbook created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@27', ARRAY[OLD."id"::uuid], 'Cookbook removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Cookbook changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_derivedvalue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'product' AND NEW."key" = 'dataQuality' THEN PERFORM derived_mark('assessment.reviewFacts@100', ARRAY[NEW."entityId"::uuid], 'Derived value created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'product' AND OLD."key" = 'dataQuality' THEN PERFORM derived_mark('assessment.reviewFacts@100', ARRAY[OLD."entityId"::uuid], 'Derived value removed'); END IF;
  ELSIF (OLD."kind" = 'product' AND OLD."key" = 'dataQuality' OR NEW."kind" = 'product' AND NEW."key" = 'dataQuality') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@100', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Derived value changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "DerivedValue_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "DerivedValue"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_derivedvalue();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_device() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Device created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Device removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Device changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@4', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Device created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@4', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Device removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@4', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Device changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality', ARRAY[NEW."id"::uuid], 'Device created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality', ARRAY[OLD."id"::uuid], 'Device removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('device.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Device changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@28', ARRAY[NEW."id"::uuid], 'Device created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@28', ARRAY[OLD."id"::uuid], 'Device removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Device changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_email() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@5', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@4', ARRAY[NEW."id"::uuid], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@4', ARRAY[OLD."id"::uuid], 'Email removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderMailId", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."orderMailId", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@36', ARRAY[NEW."ledgerPartyId"::uuid], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@36', ARRAY[OLD."ledgerPartyId"::uuid], 'Email removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@36', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@14', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@14', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."provider", OLD."mailboxId", OLD."messageId", OLD."orderMailId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."provider", NEW."mailboxId", NEW."messageId", NEW."orderMailId", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.beneficiaryResult@14', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts', ARRAY[NEW."id"::uuid], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts', ARRAY[OLD."id"::uuid], 'Email removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderMailId", OLD."ledgerPartyId", OLD."provider", OLD."mailboxId", OLD."messageId", OLD."receivedAt", OLD."checksum", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."orderMailId", NEW."ledgerPartyId", NEW."provider", NEW."mailboxId", NEW."messageId", NEW."receivedAt", NEW."checksum", NEW."deletedAt") THEN
    PERFORM derived_mark('email.relationshipFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[NEW."id"::uuid], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[OLD."id"::uuid], 'Email removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@31', ARRAY[NEW."id"::uuid], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@31', ARRAY[OLD."id"::uuid], 'Email removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@31', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Email changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@159', ARRAY[NEW."id"::uuid], 'Email created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@159', ARRAY[OLD."id"::uuid], 'Email removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderMailId", OLD."ledgerPartyId", OLD."provider", OLD."mailboxId", OLD."messageId", OLD."receivedAt", OLD."checksum", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."orderMailId", NEW."ledgerPartyId", NEW."provider", NEW."mailboxId", NEW."messageId", NEW."receivedAt", NEW."checksum", NEW."deletedAt") THEN
    PERFORM derived_mark('assessment.reviewFacts@159', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Email changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@52', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@52', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."kind", OLD."shortcode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."kind", NEW."shortcode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.workDiagnosticFacts@52', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'product' THEN PERFORM derived_mark('assessment.reviewFacts@42', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'product' THEN PERFORM derived_mark('assessment.reviewFacts@42', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'product' OR NEW."kind" = 'product') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@42', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'product' THEN PERFORM derived_mark('assessment.reviewFacts@43', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'product' THEN PERFORM derived_mark('assessment.reviewFacts@43', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'product' OR NEW."kind" = 'product') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@43', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'expense' THEN PERFORM derived_mark('assessment.reviewFacts@44', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'expense' THEN PERFORM derived_mark('assessment.reviewFacts@44', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'expense' OR NEW."kind" = 'expense') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@44', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'expense' THEN PERFORM derived_mark('assessment.reviewFacts@45', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'expense' THEN PERFORM derived_mark('assessment.reviewFacts@45', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'expense' OR NEW."kind" = 'expense') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@45', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchase' THEN PERFORM derived_mark('assessment.reviewFacts@46', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchase' THEN PERFORM derived_mark('assessment.reviewFacts@46', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'purchase' OR NEW."kind" = 'purchase') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@46', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchase' THEN PERFORM derived_mark('assessment.reviewFacts@47', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchase' THEN PERFORM derived_mark('assessment.reviewFacts@47', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'purchase' OR NEW."kind" = 'purchase') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@47', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'financialAccount' THEN PERFORM derived_mark('assessment.reviewFacts@48', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'financialAccount' THEN PERFORM derived_mark('assessment.reviewFacts@48', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'financialAccount' OR NEW."kind" = 'financialAccount') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@48', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'financialAccount' THEN PERFORM derived_mark('assessment.reviewFacts@49', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'financialAccount' THEN PERFORM derived_mark('assessment.reviewFacts@49', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'financialAccount' OR NEW."kind" = 'financialAccount') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@49', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'financialTransaction' THEN PERFORM derived_mark('assessment.reviewFacts@50', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'financialTransaction' THEN PERFORM derived_mark('assessment.reviewFacts@50', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'financialTransaction' OR NEW."kind" = 'financialTransaction') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@50', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'financialTransaction' THEN PERFORM derived_mark('assessment.reviewFacts@51', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'financialTransaction' THEN PERFORM derived_mark('assessment.reviewFacts@51', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'financialTransaction' OR NEW."kind" = 'financialTransaction') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@51', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'ledgerParty' THEN PERFORM derived_mark('assessment.reviewFacts@52', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'ledgerParty' THEN PERFORM derived_mark('assessment.reviewFacts@52', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'ledgerParty' OR NEW."kind" = 'ledgerParty') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@52', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'ledgerParty' THEN PERFORM derived_mark('assessment.reviewFacts@53', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'ledgerParty' THEN PERFORM derived_mark('assessment.reviewFacts@53', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'ledgerParty' OR NEW."kind" = 'ledgerParty') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@53', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'vendor' THEN PERFORM derived_mark('assessment.reviewFacts@54', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'vendor' THEN PERFORM derived_mark('assessment.reviewFacts@54', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'vendor' OR NEW."kind" = 'vendor') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@54', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'vendor' THEN PERFORM derived_mark('assessment.reviewFacts@55', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'vendor' THEN PERFORM derived_mark('assessment.reviewFacts@55', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'vendor' OR NEW."kind" = 'vendor') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@55', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'vendorAccount' THEN PERFORM derived_mark('assessment.reviewFacts@56', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'vendorAccount' THEN PERFORM derived_mark('assessment.reviewFacts@56', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'vendorAccount' OR NEW."kind" = 'vendorAccount') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@56', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'vendorAccount' THEN PERFORM derived_mark('assessment.reviewFacts@57', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'vendorAccount' THEN PERFORM derived_mark('assessment.reviewFacts@57', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'vendorAccount' OR NEW."kind" = 'vendorAccount') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@57', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'spendingCategory' THEN PERFORM derived_mark('assessment.reviewFacts@58', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'spendingCategory' THEN PERFORM derived_mark('assessment.reviewFacts@58', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'spendingCategory' OR NEW."kind" = 'spendingCategory') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@58', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'spendingCategory' THEN PERFORM derived_mark('assessment.reviewFacts@59', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'spendingCategory' THEN PERFORM derived_mark('assessment.reviewFacts@59', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'spendingCategory' OR NEW."kind" = 'spendingCategory') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@59', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'project' THEN PERFORM derived_mark('assessment.reviewFacts@60', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'project' THEN PERFORM derived_mark('assessment.reviewFacts@60', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'project' OR NEW."kind" = 'project') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@60', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'project' THEN PERFORM derived_mark('assessment.reviewFacts@61', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'project' THEN PERFORM derived_mark('assessment.reviewFacts@61', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'project' OR NEW."kind" = 'project') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@61', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'task' THEN PERFORM derived_mark('assessment.reviewFacts@62', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'task' THEN PERFORM derived_mark('assessment.reviewFacts@62', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'task' OR NEW."kind" = 'task') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@62', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'task' THEN PERFORM derived_mark('assessment.reviewFacts@63', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'task' THEN PERFORM derived_mark('assessment.reviewFacts@63', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'task' OR NEW."kind" = 'task') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@63', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'image' THEN PERFORM derived_mark('assessment.reviewFacts@64', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'image' THEN PERFORM derived_mark('assessment.reviewFacts@64', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'image' OR NEW."kind" = 'image') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@64', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'image' THEN PERFORM derived_mark('assessment.reviewFacts@65', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'image' THEN PERFORM derived_mark('assessment.reviewFacts@65', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'image' OR NEW."kind" = 'image') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@65', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'inventory' THEN PERFORM derived_mark('assessment.reviewFacts@66', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'inventory' THEN PERFORM derived_mark('assessment.reviewFacts@66', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'inventory' OR NEW."kind" = 'inventory') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@66', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'inventory' THEN PERFORM derived_mark('assessment.reviewFacts@67', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'inventory' THEN PERFORM derived_mark('assessment.reviewFacts@67', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'inventory' OR NEW."kind" = 'inventory') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@67', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'location' THEN PERFORM derived_mark('assessment.reviewFacts@68', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'location' THEN PERFORM derived_mark('assessment.reviewFacts@68', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'location' OR NEW."kind" = 'location') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@68', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'location' THEN PERFORM derived_mark('assessment.reviewFacts@69', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'location' THEN PERFORM derived_mark('assessment.reviewFacts@69', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'location' OR NEW."kind" = 'location') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@69', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'cookbook' THEN PERFORM derived_mark('assessment.reviewFacts@70', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'cookbook' THEN PERFORM derived_mark('assessment.reviewFacts@70', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'cookbook' OR NEW."kind" = 'cookbook') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@70', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'cookbook' THEN PERFORM derived_mark('assessment.reviewFacts@71', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'cookbook' THEN PERFORM derived_mark('assessment.reviewFacts@71', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'cookbook' OR NEW."kind" = 'cookbook') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@71', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'device' THEN PERFORM derived_mark('assessment.reviewFacts@72', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'device' THEN PERFORM derived_mark('assessment.reviewFacts@72', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'device' OR NEW."kind" = 'device') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@72', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'device' THEN PERFORM derived_mark('assessment.reviewFacts@73', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'device' THEN PERFORM derived_mark('assessment.reviewFacts@73', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'device' OR NEW."kind" = 'device') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@73', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'ingredient' THEN PERFORM derived_mark('assessment.reviewFacts@74', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'ingredient' THEN PERFORM derived_mark('assessment.reviewFacts@74', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'ingredient' OR NEW."kind" = 'ingredient') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@74', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'ingredient' THEN PERFORM derived_mark('assessment.reviewFacts@75', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'ingredient' THEN PERFORM derived_mark('assessment.reviewFacts@75', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'ingredient' OR NEW."kind" = 'ingredient') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@75', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'plant' THEN PERFORM derived_mark('assessment.reviewFacts@76', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'plant' THEN PERFORM derived_mark('assessment.reviewFacts@76', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'plant' OR NEW."kind" = 'plant') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@76', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'plant' THEN PERFORM derived_mark('assessment.reviewFacts@77', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'plant' THEN PERFORM derived_mark('assessment.reviewFacts@77', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'plant' OR NEW."kind" = 'plant') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@77', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'email' THEN PERFORM derived_mark('assessment.reviewFacts@78', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'email' THEN PERFORM derived_mark('assessment.reviewFacts@78', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'email' OR NEW."kind" = 'email') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@78', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'email' THEN PERFORM derived_mark('assessment.reviewFacts@79', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'email' THEN PERFORM derived_mark('assessment.reviewFacts@79', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'email' OR NEW."kind" = 'email') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@79', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productCategory' THEN PERFORM derived_mark('assessment.reviewFacts@80', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productCategory' THEN PERFORM derived_mark('assessment.reviewFacts@80', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'productCategory' OR NEW."kind" = 'productCategory') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@80', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productCategory' THEN PERFORM derived_mark('assessment.reviewFacts@81', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productCategory' THEN PERFORM derived_mark('assessment.reviewFacts@81', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'productCategory' OR NEW."kind" = 'productCategory') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@81', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('assessment.reviewFacts@82', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('assessment.reviewFacts@82', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'sourceTransactionRecord' OR NEW."kind" = 'sourceTransactionRecord') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@82', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('assessment.reviewFacts@83', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('assessment.reviewFacts@83', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'sourceTransactionRecord' OR NEW."kind" = 'sourceTransactionRecord') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@83', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'transactionImport' THEN PERFORM derived_mark('assessment.reviewFacts@84', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'transactionImport' THEN PERFORM derived_mark('assessment.reviewFacts@84', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'transactionImport' OR NEW."kind" = 'transactionImport') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@84', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'transactionImport' THEN PERFORM derived_mark('assessment.reviewFacts@85', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'transactionImport' THEN PERFORM derived_mark('assessment.reviewFacts@85', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'transactionImport' OR NEW."kind" = 'transactionImport') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@85', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'meal' THEN PERFORM derived_mark('assessment.reviewFacts@86', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'meal' THEN PERFORM derived_mark('assessment.reviewFacts@86', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'meal' OR NEW."kind" = 'meal') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@86', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'meal' THEN PERFORM derived_mark('assessment.reviewFacts@87', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'meal' THEN PERFORM derived_mark('assessment.reviewFacts@87', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'meal' OR NEW."kind" = 'meal') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@87', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'recipe' THEN PERFORM derived_mark('assessment.reviewFacts@88', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'recipe' THEN PERFORM derived_mark('assessment.reviewFacts@88', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'recipe' OR NEW."kind" = 'recipe') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@88', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'recipe' THEN PERFORM derived_mark('assessment.reviewFacts@89', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'recipe' THEN PERFORM derived_mark('assessment.reviewFacts@89', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'recipe' OR NEW."kind" = 'recipe') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@89', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntry' THEN PERFORM derived_mark('assessment.reviewFacts@90', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntry' THEN PERFORM derived_mark('assessment.reviewFacts@90', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'gardenEntry' OR NEW."kind" = 'gardenEntry') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@90', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntry' THEN PERFORM derived_mark('assessment.reviewFacts@91', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntry' THEN PERFORM derived_mark('assessment.reviewFacts@91', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'gardenEntry' OR NEW."kind" = 'gardenEntry') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@91', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'planting' THEN PERFORM derived_mark('assessment.reviewFacts@92', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'planting' THEN PERFORM derived_mark('assessment.reviewFacts@92', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'planting' OR NEW."kind" = 'planting') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@92', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'planting' THEN PERFORM derived_mark('assessment.reviewFacts@93', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'planting' THEN PERFORM derived_mark('assessment.reviewFacts@93', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'planting' OR NEW."kind" = 'planting') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@93', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'shipment' THEN PERFORM derived_mark('assessment.reviewFacts@94', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'shipment' THEN PERFORM derived_mark('assessment.reviewFacts@94', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'shipment' OR NEW."kind" = 'shipment') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@94', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'shipment' THEN PERFORM derived_mark('assessment.reviewFacts@95', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'shipment' THEN PERFORM derived_mark('assessment.reviewFacts@95', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'shipment' OR NEW."kind" = 'shipment') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@95', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wish' THEN PERFORM derived_mark('assessment.reviewFacts@96', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wish' THEN PERFORM derived_mark('assessment.reviewFacts@96', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'wish' OR NEW."kind" = 'wish') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@96', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wish' THEN PERFORM derived_mark('assessment.reviewFacts@97', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wish' THEN PERFORM derived_mark('assessment.reviewFacts@97', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'wish' OR NEW."kind" = 'wish') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@97', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'ledgerTransfer' THEN PERFORM derived_mark('assessment.reviewFacts@98', ARRAY[NEW."id"::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'ledgerTransfer' THEN PERFORM derived_mark('assessment.reviewFacts@98', ARRAY[OLD."id"::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'ledgerTransfer' OR NEW."kind" = 'ledgerTransfer') AND (OLD."id", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@98', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Entity changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'ledgerTransfer' THEN PERFORM derived_mark('assessment.reviewFacts@99', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'ledgerTransfer' THEN PERFORM derived_mark('assessment.reviewFacts@99', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Entity removed'); END IF;
  ELSIF (OLD."kind" = 'ledgerTransfer' OR NEW."kind" = 'ledgerTransfer') AND (OLD."shortcode", OLD."deletedAt", OLD."mergedIntoId", OLD."kind") IS DISTINCT FROM (NEW."shortcode", NEW."deletedAt", NEW."mergedIntoId", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@99', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Entity changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entityattachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('product.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'recipe' OR NEW."entityKind" = 'recipe') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'recipe' OR NEW."entityKind" = 'recipe') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('recipe.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ingredient' OR NEW."entityKind" = 'ingredient') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ingredient' OR NEW."entityKind" = 'ingredient') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('ingredient.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('ingredient.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'cookbook' OR NEW."entityKind" = 'cookbook') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'cookbook' OR NEW."entityKind" = 'cookbook') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('cookbook.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('cookbook.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' THEN PERFORM derived_mark('location.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' THEN PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'location' OR NEW."entityKind" = 'location') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' THEN PERFORM derived_mark('location.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' THEN PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'location' OR NEW."entityKind" = 'location') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('location.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('location.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'inventory' OR NEW."entityKind" = 'inventory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'inventory' OR NEW."entityKind" = 'inventory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@12', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@12', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@16', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@16', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@16', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@20', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@20', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@20', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'meal' THEN PERFORM derived_mark('meal.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'meal' THEN PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'meal' OR NEW."entityKind" = 'meal') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'meal' THEN PERFORM derived_mark('meal.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'meal' THEN PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'meal' OR NEW."entityKind" = 'meal') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('meal.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ledgerParty' THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ledgerParty' THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ledgerParty' OR NEW."entityKind" = 'ledgerParty') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ledgerTransfer' THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ledgerTransfer' THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ledgerTransfer' OR NEW."entityKind" = 'ledgerTransfer') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@6', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@6', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@6', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'project' THEN PERFORM derived_mark('project.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'project' THEN PERFORM derived_mark('project.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'project' OR NEW."entityKind" = 'project') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'project' THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'project' THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'project' OR NEW."entityKind" = 'project') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@12', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@12', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@16', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@16', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@16', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@20', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@20', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@20', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@24', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@24', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@24', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@28', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@28', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@28', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@32', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@32', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@32', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'task' THEN PERFORM derived_mark('task.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'task' THEN PERFORM derived_mark('task.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'task' OR NEW."entityKind" = 'task') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'task' THEN PERFORM derived_mark('task.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'task' THEN PERFORM derived_mark('task.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'task' OR NEW."entityKind" = 'task') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@11', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@11', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@11', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@15', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@15', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@15', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@19', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@19', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@19', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@23', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@23', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@23', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@27', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@27', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@27', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@31', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@31', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@31', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@35', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@35', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@35', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@39', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@39', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@39', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@45', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@45', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@45', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@48', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@48', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@48', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@52', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@52', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@52', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@56', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@56', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@56', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@60', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@60', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@60', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@64', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@64', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@64', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@68', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@68', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@68', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@72', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@72', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@72', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@76', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@76', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@76', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'vendor' OR NEW."entityKind" = 'vendor') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'vendor' OR NEW."entityKind" = 'vendor') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@15', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@15', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('purchase.dataQuality@15', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@18', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@18', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('purchase.dataQuality@18', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@22', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@22', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('purchase.dataQuality@22', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialAccount' OR NEW."entityKind" = 'financialAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialAccount' OR NEW."entityKind" = 'financialAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialAccount.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@10', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@10', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@10', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@14', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@14', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@14', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@18', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@18', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@18', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'wish' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'wish' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'wish' OR NEW."entityKind" = 'wish') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'wish' THEN PERFORM derived_mark('wish.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'wish' THEN PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'wish' OR NEW."entityKind" = 'wish') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('wish.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@10', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@10', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('wish.dataQuality@10', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'expense' THEN PERFORM derived_mark('expense.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'expense' THEN PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'expense' OR NEW."entityKind" = 'expense') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'expense' THEN PERFORM derived_mark('expense.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'expense' THEN PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'expense' OR NEW."entityKind" = 'expense') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@12', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@12', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@16', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@16', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@16', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@20', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@20', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@20', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@24', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@24', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@24', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' OR NEW."entityKind" = 'image') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' OR NEW."entityKind" = 'image') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."imageId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid] || ARRAY[NEW."imageId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'planting' THEN PERFORM derived_mark('planting.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'planting' THEN PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'planting' OR NEW."entityKind" = 'planting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'planting' THEN PERFORM derived_mark('planting.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'planting' THEN PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'planting' OR NEW."entityKind" = 'planting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('planting.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('planting.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@13', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@13', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('planting.dataQuality@13', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'gardenEntry' OR NEW."entityKind" = 'gardenEntry') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'gardenEntry' OR NEW."entityKind" = 'gardenEntry') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'productCategory' THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'productCategory' THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'productCategory' OR NEW."entityKind" = 'productCategory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('productCategory.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('productCategory.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'run' THEN PERFORM derived_mark('run.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'run' THEN PERFORM derived_mark('run.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'run' OR NEW."entityKind" = 'run') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('run.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('run.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'device' THEN PERFORM derived_mark('device.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'device' THEN PERFORM derived_mark('device.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'device' OR NEW."entityKind" = 'device') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('device.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('device.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('device.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'plant' THEN PERFORM derived_mark('plant.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'plant' THEN PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'plant' OR NEW."entityKind" = 'plant') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'plant' THEN PERFORM derived_mark('plant.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'plant' THEN PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'plant' OR NEW."entityKind" = 'plant') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('plant.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@10', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@10', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('plant.dataQuality@10', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@14', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@14', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('plant.dataQuality@14', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'spendingCategory' THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'spendingCategory' THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'spendingCategory' OR NEW."entityKind" = 'spendingCategory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'email' THEN PERFORM derived_mark('email.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'email' THEN PERFORM derived_mark('email.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'email' OR NEW."entityKind" = 'email') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'imageJob' THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'imageJob' THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'imageJob' OR NEW."entityKind" = 'imageJob') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'sourceTransactionRecord' OR NEW."entityKind" = 'sourceTransactionRecord') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'transactionImport' THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'transactionImport' THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'transactionImport' OR NEW."entityKind" = 'transactionImport') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'shipment' OR NEW."entityKind" = 'shipment') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'shipment' OR NEW."entityKind" = 'shipment') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('assessment.reviewFacts@104', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('assessment.reviewFacts@104', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@104', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entityexternalid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.food', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.food', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.food', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('recipe.totals@0', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('recipe.totals@0', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals@0', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('inventory.searchDocument@12', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('inventory.searchDocument@12', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@7', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@7', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity external id removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@7', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('assessment.reviewFacts@111', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('assessment.reviewFacts@111', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@111', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'settlement_ref' THEN PERFORM derived_mark('assessment.reviewFacts@140', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'settlement_ref' THEN PERFORM derived_mark('assessment.reviewFacts@140', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."kind" = 'settlement_ref' OR NEW."kind" = 'settlement_ref') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@140', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'settlement_ref' THEN PERFORM derived_mark('assessment.reviewFacts@141', ARRAY[md5((NEW."externalId")::text)::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'settlement_ref' THEN PERFORM derived_mark('assessment.reviewFacts@141', ARRAY[md5((OLD."externalId")::text)::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."kind" = 'settlement_ref' OR NEW."kind" = 'settlement_ref') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@141', ARRAY[md5((OLD."externalId")::text)::uuid] || ARRAY[md5((NEW."externalId")::text)::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'settlement_ref' THEN PERFORM derived_mark('assessment.reviewFacts@147', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'settlement_ref' THEN PERFORM derived_mark('assessment.reviewFacts@147', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."kind" = 'settlement_ref' OR NEW."kind" = 'settlement_ref') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@147', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entitylink() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@21', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@21', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@21', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@28', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@28', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@28', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@12', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@12', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@12', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@2', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@2', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@2', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@3', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@3', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@3', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@6', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@6', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@6', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@13', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@13', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@13', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@18', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@18', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@18', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@8', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@8', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity link removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@8', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('project.dataQuality@18', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('project.dataQuality@18', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('project.dataQuality@18', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@25', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@25', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('task.dataQuality@25', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@62', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@62', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('task.dataQuality@62', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchasePaymentAccount' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchasePaymentAccount' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchasePaymentAccount' OR NEW."kind" = 'purchasePaymentAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.dataQuality@4', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.dataQuality@4', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('wish.dataQuality@4', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('planting.dataQuality@4', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('planting.dataQuality@4', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (OLD."toEntityId", OLD."deletedAt", OLD."fromEntityId", OLD."kind") IS DISTINCT FROM (NEW."toEntityId", NEW."deletedAt", NEW."fromEntityId", NEW."kind") THEN
    PERFORM derived_mark('planting.dataQuality@4', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('plant.dataQuality@8', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('plant.dataQuality@8', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (OLD."toEntityId", OLD."deletedAt", OLD."fromEntityId", OLD."kind") IS DISTINCT FROM (NEW."toEntityId", NEW."deletedAt", NEW."fromEntityId", NEW."kind") THEN
    PERFORM derived_mark('plant.dataQuality@8', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('assessment.reviewFacts@112', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('assessment.reviewFacts@112', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@112', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('assessment.reviewFacts@152', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('assessment.reviewFacts@152', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@152', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchasePaymentAccount' THEN PERFORM derived_mark('assessment.reviewFacts@157', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchasePaymentAccount' THEN PERFORM derived_mark('assessment.reviewFacts@157', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchasePaymentAccount' OR NEW."kind" = 'purchasePaymentAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@157', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('assessment.reviewFacts@173', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('assessment.reviewFacts@173', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@173', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_expense() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@20', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@20', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@20', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@27', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@27', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@27', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@4', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@4', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@4', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@11', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@11', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@11', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@7', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@7', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@7', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@23', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@23', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality@23', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@1', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@1', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@1', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@3', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@3', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@3', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@5', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@5', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@5', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@12', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@12', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@12', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@9', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@9', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@9', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."cost", OLD."future", OLD."lineKind", OLD."date", OLD."purchaseId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."cost", NEW."future", NEW."lineKind", NEW."date", NEW."purchaseId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@12', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@12', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@12', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@13', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@13', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@19', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@14', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@14', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('project.dataQuality@14', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@21', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@21', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('task.dataQuality@21', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@58', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@58', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('task.dataQuality@58', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@13', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@13', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('purchase.dataQuality@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."cost", OLD."future", OLD."purchaseId", OLD."deletedAt", OLD."name") IS DISTINCT FROM (NEW."id", NEW."cost", NEW."future", NEW."purchaseId", NEW."deletedAt", NEW."name") THEN
    PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@13', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@13', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."cost", OLD."lineKind", OLD."productId", OLD."projectId", OLD."spendingCategoryId", OLD."trade", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."purchaseId", NEW."cost", NEW."lineKind", NEW."productId", NEW."projectId", NEW."spendingCategoryId", NEW."trade", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@14', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@14', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('expense.dataQuality@14', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@31', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@31', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."cost", OLD."lineKind", OLD."productId", OLD."projectId", OLD."spendingCategoryId", OLD."trade", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."purchaseId", NEW."cost", NEW."lineKind", NEW."productId", NEW."projectId", NEW."spendingCategoryId", NEW."trade", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@31', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@14', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@14', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@109', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@109', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@109', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@143', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@143', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@143', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@148', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@148', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."bookingTransactionCode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."bookingTransactionCode", NEW."deletedAt") THEN
    PERFORM derived_mark('assessment.reviewFacts@148', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@151', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@151', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@151', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@177', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@177', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."shortcode", OLD."date", OLD."projectId", OLD."purchaseId", OLD."productId", OLD."lineKind", OLD."trade", OLD."deletedAt", OLD."cost") IS DISTINCT FROM (NEW."id", NEW."name", NEW."shortcode", NEW."date", NEW."projectId", NEW."purchaseId", NEW."productId", NEW."lineKind", NEW."trade", NEW."deletedAt", NEW."cost") THEN
    PERFORM derived_mark('assessment.reviewFacts@177', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_expenseattribution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@34', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@34', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@34', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@35', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@35', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@35', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@18', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@18', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@18', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@19', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@19', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@19', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@19', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@19', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@19', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@20', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@20', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@20', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@10', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@128', ARRAY[NEW."expenseId"::uuid], 'Expense attribution created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@128', ARRAY[OLD."expenseId"::uuid], 'Expense attribution removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@128', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Expense attribution changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_externalsource() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@57', ARRAY[coalesce(NEW."vendorId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'External source created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@57', ARRAY[coalesce(OLD."vendorId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'External source removed'); END IF;
  ELSIF (true OR true) AND (OLD."vendorId", OLD."slug", OLD."issuer") IS DISTINCT FROM (NEW."vendorId", NEW."slug", NEW."issuer") THEN
    PERFORM derived_mark('project.workDiagnosticFacts@57', ARRAY[coalesce(OLD."vendorId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."vendorId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'External source changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@127', ARRAY[md5((NEW."slug")::text)::uuid], 'External source created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@127', ARRAY[md5((OLD."slug")::text)::uuid], 'External source removed'); END IF;
  ELSIF (true OR true) AND (OLD."slug", OLD."vendorId", OLD."issuer") IS DISTINCT FROM (NEW."slug", NEW."vendorId", NEW."issuer") THEN
    PERFORM derived_mark('assessment.reviewFacts@127', ARRAY[md5((OLD."slug")::text)::uuid] || ARRAY[md5((NEW."slug")::text)::uuid], 'External source changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_feedback() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('product.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('product.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('recipe.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('recipe.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('ingredient.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('ingredient.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('cookbook.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('cookbook.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('location.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('location.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('inventory.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('inventory.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('meal.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('meal.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Feedback removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('project.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('project.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('task.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('task.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('vendor.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('vendor.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('purchase.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('purchase.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialAccount.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialAccount.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialTransaction.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialTransaction.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('wish.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('wish.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('expense.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('expense.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('image.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('image.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('planting.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('planting.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('gardenEntry.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('gardenEntry.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('plant.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('plant.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@14', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@14', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@14', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@12', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@12', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@12', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('assessment.reviewFacts@108', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('assessment.reviewFacts@108', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@108', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_financialaccount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@25', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@25', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@32', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@32', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@9', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@9', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@16', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@16', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@10', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@10', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@17', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@17', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."ledgerPartyId"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."ledgerPartyId"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@12', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@12', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@12', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@26', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@26', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@27', ARRAY[NEW."providerVendorId"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@27', ARRAY[OLD."providerVendorId"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (OLD."providerVendorId", OLD."identity", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."providerVendorId", NEW."identity", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@27', ARRAY[OLD."providerVendorId"::uuid] || ARRAY[NEW."providerVendorId"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@29', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@29', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@12', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@12', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@16', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@16', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@133', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@133', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@133', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@134', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@134', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@134', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@145', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@145', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@145', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@153', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@153', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@153', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@158', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@158', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@158', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@172', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@172', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."identity", OLD."providerVendorId", OLD."ledgerPartyId", OLD."cardNumbers", OLD."deletedAt", OLD."primaryCardholderId", OLD."fundingPeriods", OLD."authorizedUsers") IS DISTINCT FROM (NEW."id", NEW."identity", NEW."providerVendorId", NEW."ledgerPartyId", NEW."cardNumbers", NEW."deletedAt", NEW."primaryCardholderId", NEW."fundingPeriods", NEW."authorizedUsers") THEN
    PERFORM derived_mark('assessment.reviewFacts@172', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_financialtransaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@24', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@24', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@31', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@31', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@31', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@8', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@8', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@15', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@15', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@9', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@9', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@16', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@16', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[NEW."ledgerTransferId"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."ledgerTransferId"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (OLD."ledgerTransferId", OLD."deletedAt", OLD."status") IS DISTINCT FROM (NEW."ledgerTransferId", NEW."deletedAt", NEW."status") THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."ledgerTransferId"::uuid] || ARRAY[NEW."ledgerTransferId"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@13', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@13', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@13', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@25', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@25', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@4', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@4', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@17', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@17', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@131', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@131', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@131', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@132', ARRAY[NEW."id"::uuid], 'Financial transaction created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@132', ARRAY[OLD."id"::uuid], 'Financial transaction removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@132', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial transaction changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_financialtransactionallocation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@23', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@23', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@23', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@30', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@30', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@30', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@7', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@7', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@7', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@14', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@14', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@14', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@8', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@8', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@8', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@15', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@15', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@15', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@14', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@14', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@14', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."transactionId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@4', ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@4', ARRAY[OLD."transactionId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (OLD."transactionId", OLD."deletedAt", OLD."purchaseId") IS DISTINCT FROM (NEW."transactionId", NEW."deletedAt", NEW."purchaseId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@4', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."transactionId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@129', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@129', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@129', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@130', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@130', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@130', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@142', ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@142', ARRAY[OLD."transactionId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@142', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_gardenentry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@15', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Garden entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@15', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Garden entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@15', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Garden entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@5', ARRAY[NEW."id"::uuid], 'Garden entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@5', ARRAY[OLD."id"::uuid], 'Garden entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Garden entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."id"::uuid], 'Garden entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."id"::uuid], 'Garden entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Garden entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[NEW."id"::uuid], 'Garden entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."id"::uuid], 'Garden entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Garden entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@9', ARRAY[NEW."id"::uuid], 'Garden entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@9', ARRAY[OLD."id"::uuid], 'Garden entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Garden entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@37', ARRAY[NEW."id"::uuid], 'Garden entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@37', ARRAY[OLD."id"::uuid], 'Garden entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@37', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Garden entry changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_image() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('product.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('product.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('product.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('recipe.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('recipe.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('ingredient.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('ingredient.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('cookbook.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('cookbook.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('location.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('location.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('location.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('location.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('inventory.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@13', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@13', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@17', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@17', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@21', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@21', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('meal.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('meal.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@16', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@16', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@16', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('project.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('project.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@13', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@13', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@17', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@17', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@21', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@21', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@25', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@25', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@29', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@29', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@33', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@33', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('task.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('task.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@12', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@12', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@16', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@16', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@20', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@20', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@24', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@24', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@28', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@28', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@32', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@32', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@36', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@36', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@36', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@40', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@40', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@40', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@46', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@46', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@46', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@49', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@49', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@49', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@53', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@53', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@53', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@57', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@57', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@57', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@61', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@61', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@61', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@65', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@65', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@65', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@69', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@69', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@69', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@73', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@73', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@73', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@77', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@77', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@77', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('vendor.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('vendor.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('vendor.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('purchase.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@16', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@16', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('purchase.dataQuality@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@19', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@19', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('purchase.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@23', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@23', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('purchase.dataQuality@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialAccount.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@11', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@11', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@15', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@15', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@19', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@19', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('wish.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('wish.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@11', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@11', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('wish.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('expense.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@13', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@13', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@17', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@17', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@21', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@21', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@25', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@25', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('image.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('image.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('planting.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('planting.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('planting.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@14', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@14', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('planting.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('gardenEntry.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('productCategory.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('productCategory.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('run.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('run.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('device.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('device.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('device.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('plant.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('plant.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@11', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@11', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('plant.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@15', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@15', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('plant.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('email.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('shipment.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('shipment.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@24', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@24', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@105', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@105', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@105', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_importsourceclaim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@37', ARRAY[NEW."ledgerPartyId"::uuid], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@37', ARRAY[OLD."ledgerPartyId"::uuid], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@37', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@10', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."canonicalClaimId", OLD."ledgerPartyId", OLD."kind", OLD."externalKey") IS DISTINCT FROM (NEW."id", NEW."canonicalClaimId", NEW."ledgerPartyId", NEW."kind", NEW."externalKey") THEN
    PERFORM derived_mark('expense.beneficiaryResult@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@10', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."canonicalClaimId", OLD."ledgerPartyId", OLD."kind", OLD."externalKey") IS DISTINCT FROM (NEW."id", NEW."canonicalClaimId", NEW."ledgerPartyId", NEW."kind", NEW."externalKey") THEN
    PERFORM derived_mark('email.relationshipFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@11', ARRAY[coalesce(NEW."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@11', ARRAY[coalesce(OLD."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (OLD."canonicalClaimId", OLD."ledgerPartyId", OLD."kind", OLD."externalKey") IS DISTINCT FROM (NEW."canonicalClaimId", NEW."ledgerPartyId", NEW."kind", NEW."externalKey") THEN
    PERFORM derived_mark('email.relationshipFacts@11', ARRAY[coalesce(OLD."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@7', ARRAY[NEW."ledgerPartyId"::uuid], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@7', ARRAY[OLD."ledgerPartyId"::uuid], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@7', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@117', ARRAY[NEW."id"::uuid], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@117', ARRAY[OLD."id"::uuid], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@117', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@118', ARRAY[NEW."id"::uuid], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@118', ARRAY[OLD."id"::uuid], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@118', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@167', ARRAY[NEW."id"::uuid], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@167', ARRAY[OLD."id"::uuid], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."canonicalClaimId", OLD."ledgerPartyId", OLD."kind", OLD."externalKey") IS DISTINCT FROM (NEW."id", NEW."canonicalClaimId", NEW."ledgerPartyId", NEW."kind", NEW."externalKey") THEN
    PERFORM derived_mark('assessment.reviewFacts@167', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Import source claim changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@168', ARRAY[NEW."canonicalClaimId"::uuid], 'Import source claim created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@168', ARRAY[OLD."canonicalClaimId"::uuid], 'Import source claim removed'); END IF;
  ELSIF (true OR true) AND (OLD."canonicalClaimId", OLD."ledgerPartyId", OLD."kind", OLD."externalKey") IS DISTINCT FROM (NEW."canonicalClaimId", NEW."ledgerPartyId", NEW."kind", NEW."externalKey") THEN
    PERFORM derived_mark('assessment.reviewFacts@168', ARRAY[OLD."canonicalClaimId"::uuid] || ARRAY[NEW."canonicalClaimId"::uuid], 'Import source claim changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_importsourceorder() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@20', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@29', ARRAY[NEW."purchaseId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@29', ARRAY[OLD."purchaseId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@29', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[NEW."purchaseId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[OLD."purchaseId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."sourceClaimId") IS DISTINCT FROM (NEW."purchaseId", NEW."sourceClaimId") THEN
    PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(NEW."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(OLD."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."sourceClaimId", OLD."checksum") IS DISTINCT FROM (NEW."purchaseId", NEW."sourceClaimId", NEW."checksum") THEN
    PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(OLD."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@9', ARRAY[NEW."sourceClaimId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@9', ARRAY[OLD."sourceClaimId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@9', ARRAY[OLD."sourceClaimId"::uuid] || ARRAY[NEW."sourceClaimId"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@115', ARRAY[NEW."id"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@115', ARRAY[OLD."id"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@115', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@116', ARRAY[NEW."id"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@116', ARRAY[OLD."id"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@116', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@166', ARRAY[NEW."purchaseId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@166', ARRAY[OLD."purchaseId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."sourceClaimId", OLD."checksum") IS DISTINCT FROM (NEW."purchaseId", NEW."sourceClaimId", NEW."checksum") THEN
    PERFORM derived_mark('assessment.reviewFacts@166', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Import source order changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_importsourceproduct() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Import source product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@21', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@21', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@21', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@45', ARRAY[NEW."sourceOrderId"::uuid], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@45', ARRAY[OLD."sourceOrderId"::uuid], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@45', ARRAY[OLD."sourceOrderId"::uuid] || ARRAY[NEW."sourceOrderId"::uuid], 'Import source product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@30', ARRAY[NEW."sourceOrderId"::uuid], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@30', ARRAY[OLD."sourceOrderId"::uuid], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@30', ARRAY[OLD."sourceOrderId"::uuid] || ARRAY[NEW."sourceOrderId"::uuid], 'Import source product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@113', ARRAY[NEW."productId"::uuid], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@113', ARRAY[OLD."productId"::uuid], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@113', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Import source product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@114', ARRAY[NEW."expenseId"::uuid], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@114', ARRAY[OLD."expenseId"::uuid], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@114', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid], 'Import source product changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ingredient() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@1', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@1', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."naKinds") IS DISTINCT FROM (NEW."id", NEW."naKinds") THEN
    PERFORM derived_mark('product.conversionCoverage@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@1', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@1', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@10', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@10', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@10', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@10', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@22', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@22', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@22', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ingredient changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@29', ARRAY[NEW."id"::uuid], 'Ingredient created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@29', ARRAY[OLD."id"::uuid], 'Ingredient removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ingredient changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_inventoryentry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."locationId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."locationId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."locationId", OLD."placement", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."locationId", NEW."placement", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."locationId"::uuid] || ARRAY[NEW."locationId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@12', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@12', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@12', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation', ARRAY[NEW."id"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation', ARRAY[OLD."id"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership', ARRAY[NEW."id"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership', ARRAY[OLD."id"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.ownership', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@2', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@2', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.ownership@2', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[NEW."id"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."id"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[NEW."id"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."id"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@23', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@23', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@23', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@25', ARRAY[NEW."id"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@25', ARRAY[OLD."id"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@110', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@110', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@110', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@149', ARRAY[NEW."productId"::uuid], 'Inventory entry created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@149', ARRAY[OLD."productId"::uuid], 'Inventory entry removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@149', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Inventory entry changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ledgerparty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@36', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@36', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@36', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@37', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@37', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@37', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@38', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@38', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@38', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@39', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@39', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@39', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@40', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@40', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@40', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@41', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@41', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@41', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@42', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@42', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@42', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@20', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@20', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@21', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@21', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@22', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@22', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@23', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@23', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@24', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@24', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@25', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@25', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@26', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@26', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@21', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@21', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@22', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@22', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@23', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@23', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@24', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@24', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@25', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@25', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@26', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@26', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@27', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@27', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@24', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@24', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@24', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@18', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@18', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."kind", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."kind", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@8', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@8', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@39', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@39', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@39', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@40', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@40', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@40', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@9', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@9', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."kind", OLD."name", OLD."shortcode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."kind", NEW."name", NEW."shortcode", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.beneficiaryResult@9', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@8', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@8', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@18', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@18', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@135', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@135', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@135', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@146', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@146', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@146', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@154', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@154', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@154', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@169', ARRAY[NEW."id"::uuid], 'Ledger party created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@169', ARRAY[OLD."id"::uuid], 'Ledger party removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@169', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger party changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ledgertransfer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[NEW."id"::uuid], 'Ledger transfer created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."id"::uuid], 'Ledger transfer removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger transfer changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@25', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger transfer created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@25', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger transfer removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@25', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Ledger transfer changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@41', ARRAY[NEW."id"::uuid], 'Ledger transfer created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@41', ARRAY[OLD."id"::uuid], 'Ledger transfer removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@41', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Ledger transfer changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@44', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@44', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@44', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."parentId"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."parentId"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."parentId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."parentId"::uuid] || ARRAY[NEW."parentId"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@11', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@11', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@7', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@7', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@14', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@14', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productId") THEN
    PERFORM derived_mark('inventory.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@22', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@22', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@26', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@26', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@26', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@9', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@9', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@10', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@10', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@26', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@26', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@150', ARRAY[NEW."id"::uuid], 'Location created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@150', ARRAY[OLD."id"::uuid], 'Location removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@150', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Location changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_meal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@5', ARRAY[NEW."id"::uuid], 'Meal created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@5', ARRAY[OLD."id"::uuid], 'Meal removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Meal changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument', ARRAY[NEW."id"::uuid], 'Meal created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."id"::uuid], 'Meal removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Meal changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[NEW."id"::uuid], 'Meal created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."id"::uuid], 'Meal removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Meal changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@27', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@27', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@27', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Meal changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@35', ARRAY[NEW."id"::uuid], 'Meal created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@35', ARRAY[OLD."id"::uuid], 'Meal removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@35', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Meal changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ordermail() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@5', ARRAY[NEW."id"::uuid], 'Order mail created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@5', ARRAY[OLD."id"::uuid], 'Order mail removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Order mail changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@38', ARRAY[NEW."ledgerPartyId"::uuid], 'Order mail created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@38', ARRAY[OLD."ledgerPartyId"::uuid], 'Order mail removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@38', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid], 'Order mail changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@11', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId") THEN
    PERFORM derived_mark('expense.beneficiaryResult@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@1', ARRAY[NEW."id"::uuid], 'Order mail created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@1', ARRAY[OLD."id"::uuid], 'Order mail removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."vendorId", OLD."rawChecksum") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."vendorId", NEW."rawChecksum") THEN
    PERFORM derived_mark('email.relationshipFacts@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Order mail changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@15', ARRAY[NEW."id"::uuid], 'Order mail created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@15', ARRAY[OLD."id"::uuid], 'Order mail removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Order mail changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@160', ARRAY[NEW."id"::uuid], 'Order mail created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@160', ARRAY[OLD."id"::uuid], 'Order mail removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."vendorId", OLD."rawChecksum") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."vendorId", NEW."rawChecksum") THEN
    PERFORM derived_mark('assessment.reviewFacts@160', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Order mail changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ordermailattachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@7', ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@7', ARRAY[OLD."orderMailId"::uuid], 'Order mail attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@7', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@42', ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@42', ARRAY[OLD."orderMailId"::uuid], 'Order mail attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@42', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@12', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@12', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderMailId", OLD."providerAttachmentId") IS DISTINCT FROM (NEW."id", NEW."orderMailId", NEW."providerAttachmentId") THEN
    PERFORM derived_mark('expense.beneficiaryResult@12', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@3', ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@3', ARRAY[OLD."orderMailId"::uuid], 'Order mail attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."orderMailId", OLD."providerAttachmentId", OLD."checksum") IS DISTINCT FROM (NEW."orderMailId", NEW."providerAttachmentId", NEW."checksum") THEN
    PERFORM derived_mark('email.relationshipFacts@3', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@16', ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@16', ARRAY[OLD."orderMailId"::uuid], 'Order mail attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@16', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@162', ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@162', ARRAY[OLD."orderMailId"::uuid], 'Order mail attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."orderMailId", OLD."providerAttachmentId", OLD."checksum") IS DISTINCT FROM (NEW."orderMailId", NEW."providerAttachmentId", NEW."checksum") THEN
    PERFORM derived_mark('assessment.reviewFacts@162', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail attachment changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ordermailevent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@6', ARRAY[NEW."id"::uuid], 'Order mail event created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@6', ARRAY[OLD."id"::uuid], 'Order mail event removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Order mail event changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@41', ARRAY[NEW."orderMailId"::uuid], 'Order mail event created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@41', ARRAY[OLD."orderMailId"::uuid], 'Order mail event removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@41', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail event changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@13', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail event created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@13', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail event removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderMailId", OLD."supersededAt") IS DISTINCT FROM (NEW."id", NEW."orderMailId", NEW."supersededAt") THEN
    PERFORM derived_mark('expense.beneficiaryResult@13', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Order mail event changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@2', ARRAY[NEW."orderMailId"::uuid], 'Order mail event created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@2', ARRAY[OLD."orderMailId"::uuid], 'Order mail event removed'); END IF;
  ELSIF (true OR true) AND (OLD."orderMailId", OLD."orderId", OLD."amount", OLD."supersededAt") IS DISTINCT FROM (NEW."orderMailId", NEW."orderId", NEW."amount", NEW."supersededAt") THEN
    PERFORM derived_mark('email.relationshipFacts@2', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail event changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@10', ARRAY[NEW."orderMailId"::uuid], 'Order mail event created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@10', ARRAY[OLD."orderMailId"::uuid], 'Order mail event removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@10', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail event changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@161', ARRAY[NEW."orderMailId"::uuid], 'Order mail event created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@161', ARRAY[OLD."orderMailId"::uuid], 'Order mail event removed'); END IF;
  ELSIF (true OR true) AND (OLD."orderMailId", OLD."orderId", OLD."amount", OLD."supersededAt", OLD."event", OLD."sourceKey") IS DISTINCT FROM (NEW."orderMailId", NEW."orderId", NEW."amount", NEW."supersededAt", NEW."event", NEW."sourceKey") THEN
    PERFORM derived_mark('assessment.reviewFacts@161', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid], 'Order mail event changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_plant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@34', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Plant created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@34', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Plant removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@34', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Plant changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@8', ARRAY[NEW."id"::uuid], 'Plant created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@8', ARRAY[OLD."id"::uuid], 'Plant removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Plant changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@9', ARRAY[NEW."id"::uuid], 'Plant created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@9', ARRAY[OLD."id"::uuid], 'Plant removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."gardenGuideKey", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."gardenGuideKey", NEW."deletedAt") THEN
    PERFORM derived_mark('gardenEntry.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Plant changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument', ARRAY[NEW."id"::uuid], 'Plant created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."id"::uuid], 'Plant removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Plant changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality', ARRAY[NEW."id"::uuid], 'Plant created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."id"::uuid], 'Plant removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Plant changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@30', ARRAY[NEW."id"::uuid], 'Plant created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@30', ARRAY[OLD."id"::uuid], 'Plant removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Plant changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_planting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."sourceProductId"::uuid], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."sourceProductId"::uuid], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (OLD."sourceProductId", OLD."deletedAt") IS DISTINCT FROM (NEW."sourceProductId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."sourceProductId"::uuid] || ARRAY[NEW."sourceProductId"::uuid], 'Planting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@35', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@35', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@35', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Planting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument', ARRAY[NEW."id"::uuid], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."id"::uuid], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Planting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality', ARRAY[NEW."id"::uuid], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."id"::uuid], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Planting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@8', ARRAY[NEW."id"::uuid], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@8', ARRAY[OLD."id"::uuid], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."plantId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."plantId", NEW."deletedAt") THEN
    PERFORM derived_mark('gardenEntry.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Planting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@7', ARRAY[NEW."plantId"::uuid], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@7', ARRAY[OLD."plantId"::uuid], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (OLD."plantId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."plantId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('plant.dataQuality@7', ARRAY[OLD."plantId"::uuid] || ARRAY[NEW."plantId"::uuid], 'Planting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@38', ARRAY[NEW."id"::uuid], 'Planting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@38', ARRAY[OLD."id"::uuid], 'Planting removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@38', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Planting changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_product() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."stockTracked", OLD."categoryId") IS DISTINCT FROM (NEW."id", NEW."stockTracked", NEW."categoryId") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.food', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.food', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."fdc_id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."fdc_id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.food', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@0', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@0', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@2', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@2', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."name", OLD."shortcode", OLD."categoryId", OLD."fdc_id", OLD."labelNutrition", OLD."usdaUnavailable", OLD."price", OLD."deletedAt") IS DISTINCT FROM (NEW."ingredientId", NEW."name", NEW."shortcode", NEW."categoryId", NEW."fdc_id", NEW."labelNutrition", NEW."usdaUnavailable", NEW."price", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.totals@2', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."ingredientId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."ingredientId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@0', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@0', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@1', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@1', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('location.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@0', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@0', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@1', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@1', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.ownership@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@9', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@9', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@10', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@10', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('inventory.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@15', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@15', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@18', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@18', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('inventory.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@36', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@36', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@36', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@21', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@21', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@21', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@11', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@11', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@15', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@15', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@19', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@19', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@22', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@22', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@26', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@26', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@30', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@30', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@11', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@11', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@12', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@12', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@13', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@13', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@18', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@18', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@22', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@22', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@26', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@26', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@29', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@29', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@33', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@33', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@37', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@37', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@37', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@44', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@44', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@44', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@50', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@50', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@50', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@55', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@55', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@55', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@59', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@59', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@59', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@63', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@63', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@63', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@66', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@66', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@66', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@70', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@70', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@70', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@74', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@74', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@74', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@14', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@14', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@20', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@20', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('purchase.dataQuality@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@34', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@34', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."categoryId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."categoryId") THEN
    PERFORM derived_mark('purchase.dataQuality@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@9', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@9', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."model", OLD."brandId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."model", NEW."brandId", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@8', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@8', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('wish.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@8', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@8', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@10', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@10', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('expense.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@15', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@15', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@22', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@22', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('expense.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@26', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@26', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@35', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@35', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality@35', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@8', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@8', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@11', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@11', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('planting.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[NEW."categoryId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[OLD."categoryId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."categoryId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."categoryId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[OLD."categoryId"::uuid] || ARRAY[NEW."categoryId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[NEW."categoryId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[OLD."categoryId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."categoryId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."categoryId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[OLD."categoryId"::uuid] || ARRAY[NEW."categoryId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('device.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('device.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@4', ARRAY[NEW."growsPlantId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@4', ARRAY[OLD."growsPlantId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."growsPlantId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."growsPlantId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('plant.dataQuality@4', ARRAY[OLD."growsPlantId"::uuid] || ARRAY[NEW."growsPlantId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@12', ARRAY[NEW."growsPlantId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@12', ARRAY[OLD."growsPlantId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."growsPlantId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."growsPlantId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('plant.dataQuality@12', ARRAY[OLD."growsPlantId"::uuid] || ARRAY[NEW."growsPlantId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@13', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@13', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@103', ARRAY[md5((NEW."shortcode")::text)::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@103', ARRAY[md5((OLD."shortcode")::text)::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."shortcode", OLD."updatedAt", OLD."tags", OLD."deletedAt") IS DISTINCT FROM (NEW."shortcode", NEW."updatedAt", NEW."tags", NEW."deletedAt") THEN
    PERFORM derived_mark('assessment.reviewFacts@103', ARRAY[md5((OLD."shortcode")::text)::uuid] || ARRAY[md5((NEW."shortcode")::text)::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@181', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@181', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('assessment.reviewFacts@181', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@183', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@183', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."kind") IS DISTINCT FROM (NEW."id", NEW."kind") THEN
    PERFORM derived_mark('assessment.reviewFacts@183', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_productcategory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@15', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@15', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@45', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."stockTracked", OLD."parentId", OLD."name", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."stockTracked", NEW."parentId", NEW."name", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@3', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@3', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@10', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@10', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@28', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@28', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@10', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@10', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@37', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@37', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@37', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@22', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@22', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@22', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@35', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@35', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@35', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@9', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@9', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@27', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@27', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@32', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@32', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@101', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@101', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@101', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@182', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@182', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('assessment.reviewFacts@182', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@185', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@185', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@185', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@186', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@186', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@186', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@187', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@187', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@187', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@188', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@188', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@188', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."startDate", OLD."endDate", OLD."status", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."startDate", NEW."endDate", NEW."status", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."parentProjectId"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."parentProjectId"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentProjectId", OLD."startDate", OLD."endDate", OLD."status", OLD."deletedAt") IS DISTINCT FROM (NEW."parentProjectId", NEW."startDate", NEW."endDate", NEW."status", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."parentProjectId"::uuid] || ARRAY[NEW."parentProjectId"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."startDate", OLD."endDate", OLD."status", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."startDate", NEW."endDate", NEW."status", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."parentProjectId"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."parentProjectId"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentProjectId", OLD."startDate", OLD."endDate", OLD."status", OLD."deletedAt") IS DISTINCT FROM (NEW."parentProjectId", NEW."startDate", NEW."endDate", NEW."status", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."parentProjectId"::uuid] || ARRAY[NEW."parentProjectId"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@39', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@39', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@39', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."startDate", OLD."endDate", OLD."status", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."startDate", NEW."endDate", NEW."status", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."parentProjectId"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."parentProjectId"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentProjectId", OLD."startDate", OLD."endDate", OLD."status", OLD."deletedAt") IS DISTINCT FROM (NEW."parentProjectId", NEW."startDate", NEW."endDate", NEW."status", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."parentProjectId"::uuid] || ARRAY[NEW."parentProjectId"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."costEstimate", OLD."deletedAt", OLD."parentProjectId") IS DISTINCT FROM (NEW."id", NEW."costEstimate", NEW."deletedAt", NEW."parentProjectId") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@15', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@15', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@16', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@16', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@17', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@17', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@23', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@23', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('project.rollups@23', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@9', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@9', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@10', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@10', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@10', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@10', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@42', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@42', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."defaultTrade", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."defaultTrade", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@42', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@43', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@43', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."defaultTrade", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."defaultTrade", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@43', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@47', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@47', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@47', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@14', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@14', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@15', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@15', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@16', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@16', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@32', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@32', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."defaultTrade", OLD."parentProjectId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."defaultTrade", NEW."parentProjectId") THEN
    PERFORM derived_mark('expense.dataQuality@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@33', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@33', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."defaultTrade", OLD."parentProjectId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."defaultTrade", NEW."parentProjectId") THEN
    PERFORM derived_mark('expense.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@22', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@22', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@179', ARRAY[NEW."id"::uuid], 'Project created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@179', ARRAY[OLD."id"::uuid], 'Project removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."emoji", OLD."shortcode", OLD."parentProjectId", OLD."startDate", OLD."endDate", OLD."deletedAt", OLD."defaultTrade") IS DISTINCT FROM (NEW."id", NEW."name", NEW."emoji", NEW."shortcode", NEW."parentProjectId", NEW."startDate", NEW."endDate", NEW."deletedAt", NEW."defaultTrade") THEN
    PERFORM derived_mark('assessment.reviewFacts@179', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Project changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_purchase() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@19', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@19', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@26', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@26', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@3', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@3', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@10', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@10', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@18', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@18', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@19', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@19', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@4', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@4', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@11', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@11', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@40', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@40', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@40', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@14', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@14', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@20', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@5', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@5', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@4', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@4', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@4', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@5', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@5', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."vendorId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."vendorId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."vendorId"::uuid] || ARRAY[NEW."vendorId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@5', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@5', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."vendorId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."vendorId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@17', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@17', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@7', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@7', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@18', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@18', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."vendorId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."vendorId") THEN
    PERFORM derived_mark('expense.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@34', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@34', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@5', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderId", OLD."vendorId", OLD."vendorAccountId", OLD."statedTotal", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."orderId", NEW."vendorId", NEW."vendorAccountId", NEW."statedTotal", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('email.relationshipFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@4', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@4', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorAccountId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorAccountId", NEW."deletedAt") THEN
    PERFORM derived_mark('email.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@11', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@11', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@4', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@4', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('shipment.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@15', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@15', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@119', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@119', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@119', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@120', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@120', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@120', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@144', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@144', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@144', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@164', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@164', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderId", OLD."vendorId", OLD."vendorAccountId", OLD."statedTotal", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."orderId", NEW."vendorId", NEW."vendorAccountId", NEW."statedTotal", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('assessment.reviewFacts@164', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@178', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@178', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."defaultProjectId", OLD."defaultTrade", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."defaultProjectId", NEW."defaultTrade", NEW."deletedAt") THEN
    PERFORM derived_mark('assessment.reviewFacts@178', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@184', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@184', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@184', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_purchasepaymentevidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@41', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase payment evidence created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@41', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase payment evidence removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@41', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase payment evidence changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid], 'Purchase payment evidence created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid], 'Purchase payment evidence removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Purchase payment evidence changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@171', ARRAY[NEW."purchaseId"::uuid], 'Purchase payment evidence created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@171', ARRAY[OLD."purchaseId"::uuid], 'Purchase payment evidence removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@171', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Purchase payment evidence changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_recipe() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt', 'totals', 'totalsComputedAt', 'totalsPublishedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt', 'totals', 'totalsComputedAt', 'totalsPublishedAt']) THEN
    PERFORM derived_mark('recipe.totals', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@4', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@4', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.totals@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt', 'totalsPublishedAt', 'totalsComputedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt', 'totalsPublishedAt', 'totalsComputedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@11', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@11', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@12', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@12', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."cookbookId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."cookbookId", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[NEW."cookbookId"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."cookbookId"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."cookbookId", OLD."deletedAt") IS DISTINCT FROM (NEW."cookbookId", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."cookbookId"::uuid] || ARRAY[NEW."cookbookId"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@9', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@9', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."totals", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."totals", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@5', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@5', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@9', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@9', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."totals", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."totals", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@42', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@42', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@42', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Recipe changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@36', ARRAY[NEW."id"::uuid], 'Recipe created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@36', ARRAY[OLD."id"::uuid], 'Recipe removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@36', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Recipe changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_shipment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@45', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Shipment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Shipment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Shipment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.eventSummary', ARRAY[NEW."id"::uuid], 'Shipment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.eventSummary', ARRAY[OLD."id"::uuid], 'Shipment removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('shipment.eventSummary', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Shipment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[NEW."id"::uuid], 'Shipment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."id"::uuid], 'Shipment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Shipment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[NEW."id"::uuid], 'Shipment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."id"::uuid], 'Shipment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Shipment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@39', ARRAY[NEW."id"::uuid], 'Shipment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@39', ARRAY[OLD."id"::uuid], 'Shipment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@39', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Shipment changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_sourcetransactionrecord() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@46', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Source transaction record created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@46', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Source transaction record removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@46', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Source transaction record changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[NEW."id"::uuid], 'Source transaction record created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."id"::uuid], 'Source transaction record removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Source transaction record changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@33', ARRAY[NEW."id"::uuid], 'Source transaction record created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@33', ARRAY[OLD."id"::uuid], 'Source transaction record removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Source transaction record changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@136', ARRAY[md5((NEW."chargeKey")::text)::uuid], 'Source transaction record created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@136', ARRAY[md5((OLD."chargeKey")::text)::uuid], 'Source transaction record removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@136', ARRAY[md5((OLD."chargeKey")::text)::uuid] || ARRAY[md5((NEW."chargeKey")::text)::uuid], 'Source transaction record changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@137', ARRAY[md5((NEW."externalId")::text)::uuid], 'Source transaction record created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@137', ARRAY[md5((OLD."externalId")::text)::uuid], 'Source transaction record removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@137', ARRAY[md5((OLD."externalId")::text)::uuid] || ARRAY[md5((NEW."externalId")::text)::uuid], 'Source transaction record changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@138', ARRAY[md5((NEW."legacyReference")::text)::uuid], 'Source transaction record created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@138', ARRAY[md5((OLD."legacyReference")::text)::uuid], 'Source transaction record removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@138', ARRAY[md5((OLD."legacyReference")::text)::uuid] || ARRAY[md5((NEW."legacyReference")::text)::uuid], 'Source transaction record changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_spendingcategory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@7', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@7', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@7', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@7', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@47', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@47', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@47', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@7', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@7', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@32', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@32', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('purchase.dataQuality@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@25', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@25', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@26', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@26', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@11', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@11', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.searchDocument@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@12', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@12', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.searchDocument@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@29', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@29', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@30', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@30', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.dataQuality@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@11', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@11', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('productCategory.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@21', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@21', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@190', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@190', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@190', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@191', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@191', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@191', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@192', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@192', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@192', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@193', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@193', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@193', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@194', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@194', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@194', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@195', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@195', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@195', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@196', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@196', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@196', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_task() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."subjectProductId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."subjectProductId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."subjectProductId", OLD."deletedAt") IS DISTINCT FROM (NEW."subjectProductId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."subjectProductId"::uuid] || ARRAY[NEW."subjectProductId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@8', ARRAY[NEW."parentTaskId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@8', ARRAY[OLD."parentTaskId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentTaskId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."parentTaskId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@8', ARRAY[OLD."parentTaskId"::uuid] || ARRAY[NEW."parentTaskId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@9', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@9', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."parentTaskId", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."parentTaskId", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@8', ARRAY[NEW."parentTaskId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@8', ARRAY[OLD."parentTaskId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentTaskId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."parentTaskId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@8', ARRAY[OLD."parentTaskId"::uuid] || ARRAY[NEW."parentTaskId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@9', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@9', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."parentTaskId", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."parentTaskId", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@48', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@48', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Task removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@48', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@8', ARRAY[NEW."parentTaskId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@8', ARRAY[OLD."parentTaskId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."parentTaskId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."parentTaskId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@8', ARRAY[OLD."parentTaskId"::uuid] || ARRAY[NEW."parentTaskId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@9', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@9', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."parentTaskId", OLD."projectId", OLD."projectMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."parentTaskId", NEW."projectId", NEW."projectMode", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@7', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@7', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('project.dataQuality@7', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@10', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@10', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."subjectProductId") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."subjectProductId") THEN
    PERFORM derived_mark('project.dataQuality@10', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@8', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@8', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@17', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@17', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."subjectProductId") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."subjectProductId") THEN
    PERFORM derived_mark('task.dataQuality@17', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@41', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@41', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."trade", OLD."projectId", OLD."subjectProductId", OLD."parentTaskId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."trade", NEW."projectId", NEW."subjectProductId", NEW."parentTaskId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@41', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@54', ARRAY[NEW."projectId"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@54', ARRAY[OLD."projectId"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."subjectProductId") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."subjectProductId") THEN
    PERFORM derived_mark('task.dataQuality@54', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@23', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@23', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@180', ARRAY[NEW."id"::uuid], 'Task created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@180', ARRAY[OLD."id"::uuid], 'Task removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."dueDate", OLD."dueEndDate", OLD."projectId", OLD."projectMode", OLD."parentTaskId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."dueDate", NEW."dueEndDate", NEW."projectId", NEW."projectMode", NEW."parentTaskId", NEW."deletedAt") THEN
    PERFORM derived_mark('assessment.reviewFacts@180', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Task changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_transactionimport() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@49', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@49', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@49', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[NEW."id"::uuid], 'Transaction import created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."id"::uuid], 'Transaction import removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Transaction import changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@34', ARRAY[NEW."id"::uuid], 'Transaction import created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@34', ARRAY[OLD."id"::uuid], 'Transaction import removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Transaction import changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_transactionimportrecord() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@54', ARRAY[coalesce(NEW."importId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import record created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@54', ARRAY[coalesce(OLD."importId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import record removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@54', ARRAY[coalesce(OLD."importId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."importId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Transaction import record changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@139', ARRAY[NEW."statementRowId"::uuid], 'Transaction import record created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@139', ARRAY[OLD."statementRowId"::uuid], 'Transaction import record removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@139', ARRAY[OLD."statementRowId"::uuid] || ARRAY[NEW."statementRowId"::uuid], 'Transaction import record changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_vendor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@9', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@9', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@5', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@5', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@20', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@20', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@11', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@11', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@19', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@19', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@50', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@50', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@50', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@23', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@23', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@27', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@27', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@31', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@31', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@31', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@14', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@14', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@30', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@30', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@34', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@34', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@38', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@38', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@38', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@51', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@51', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@51', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@67', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@67', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@67', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@71', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@71', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@71', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@75', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@75', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@75', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@17', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@17', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@21', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@21', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@44', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@44', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@44', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@4', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@4', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@7', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@7', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@10', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@10', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@13', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@13', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@17', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@17', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@22', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@22', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@10', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@10', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@9', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@9', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@10', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@10', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@11', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@11', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@19', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@19', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@23', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@23', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@28', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@28', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@12', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@12', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('productCategory.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@4', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@4', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('run.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('device.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@13', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@13', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@19', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@19', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@121', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@121', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@121', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@122', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@122', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@122', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@123', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@123', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@123', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@126', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@126', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."website", OLD."browserDomains", OLD."deletedAt", OLD."systemKey", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."website", NEW."browserDomains", NEW."deletedAt", NEW."systemKey", NEW."shortcode") THEN
    PERFORM derived_mark('assessment.reviewFacts@126', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@155', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@155', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@155', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@189', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@189', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@189', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_vendoraccount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@22', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@22', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@29', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@29', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@6', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@6', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@13', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@13', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@7', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@7', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@14', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@14', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@51', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@51', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@51', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@33', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@33', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@6', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@6', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@6', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@6', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('email.relationshipFacts@6', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@5', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@5', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('email.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@12', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@12', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@20', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@20', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@124', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@124', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@124', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@125', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@125', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@125', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@156', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@156', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@156', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@165', ARRAY[NEW."id"::uuid], 'Vendor account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@165', ARRAY[OLD."id"::uuid], 'Vendor account removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('assessment.reviewFacts@165', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor account changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_wish() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument', ARRAY[NEW."id"::uuid], 'Wish created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."id"::uuid], 'Wish removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Wish changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality', ARRAY[NEW."id"::uuid], 'Wish created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."id"::uuid], 'Wish removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Wish changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@40', ARRAY[NEW."id"::uuid], 'Wish created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('assessment.reviewFacts@40', ARRAY[OLD."id"::uuid], 'Wish removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@40', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Wish changed');
  END IF;
  RETURN NULL;
END $$;
