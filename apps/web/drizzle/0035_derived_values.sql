CREATE SEQUENCE "public"."DerivedTicket" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "DerivedDirty" (
	"target" text NOT NULL,
	"ref" uuid NOT NULL,
	"ticket" bigint DEFAULT nextval('"DerivedTicket"') NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"dirtiedAt" timestamp DEFAULT now() NOT NULL,
	"readyAt" timestamp DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastError" text,
	CONSTRAINT "DerivedDirty_target_ref_pk" PRIMARY KEY("target","ref")
);
--> statement-breakpoint
CREATE TABLE "DerivedValue" (
	"entityId" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"sortNumber" double precision,
	"sortDate" timestamp,
	"sortText" text,
	"decidedBy" jsonb,
	"inputHash" text,
	"computedAt" timestamp NOT NULL,
	CONSTRAINT "DerivedValue_entityId_key_pk" PRIMARY KEY("entityId","key")
);
--> statement-breakpoint
DROP TABLE "EntityQuality" CASCADE;--> statement-breakpoint
DROP TABLE "EntityQualityCheck" CASCADE;--> statement-breakpoint
ALTER TABLE "DerivedValue" ADD CONSTRAINT "DerivedValue_entity_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "DerivedDirty_ready_idx" ON "DerivedDirty" USING btree ("priority","readyAt");--> statement-breakpoint
CREATE INDEX "DerivedValue_kind_key_number_idx" ON "DerivedValue" USING btree ("kind","key","sortNumber");--> statement-breakpoint
CREATE INDEX "DerivedValue_kind_key_date_idx" ON "DerivedValue" USING btree ("kind","key","sortDate");--> statement-breakpoint
CREATE INDEX "DerivedValue_kind_key_text_idx" ON "DerivedValue" USING btree ("kind","key","sortText");--> statement-breakpoint
-- One open AI evaluation per logical target: cancel older duplicates before the slot index.
ALTER TABLE "AiEvaluation" ADD COLUMN "slotKey" text GENERATED ALWAYS AS (
  octet_length("feature")::text || ':' || "feature" || octet_length(COALESCE("target"->>'entity', ''))::text || ':' || COALESCE("target"->>'entity', '') || octet_length(COALESCE("target"->>'recordId', ''))::text || ':' || COALESCE("target"->>'recordId', '') || octet_length(COALESCE("target"->>'field', ''))::text || ':' || COALESCE("target"->>'field', '') || octet_length(COALESCE("target"->>'otherId', ''))::text || ':' || COALESCE("target"->>'otherId', '')
) STORED NOT NULL;
--> statement-breakpoint
WITH ranked AS (
  SELECT id, first_value(id) OVER slot AS newest,
    row_number() OVER slot AS position
  FROM "AiEvaluation"
  WHERE state IN ('queued', 'retry_wait')
  WINDOW slot AS (PARTITION BY "slotKey" ORDER BY "createdAt" DESC, id DESC)
), cancelled AS (
  UPDATE "AiEvaluation" e
  SET state = 'cancelled', receipt = jsonb_build_object('supersededBy', r.newest),
    error = 'Superseded by a newer evaluation in the same slot', "updatedAt" = now()
  FROM ranked r WHERE e.id = r.id AND r.position > 1
  RETURNING e.id
)
UPDATE "Job" j
SET state = 'cancelled', generation = generation + 1,
  "waitReason" = NULL, "waitUntil" = NULL,
  "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
FROM cancelled e
WHERE j.key = 'ai-evaluation:' || e.id::text
  AND j.state IN ('queued', 'running', 'retry_wait', 'paused');
--> statement-breakpoint
CREATE UNIQUE INDEX "AiEvaluation_open_slot_key" ON "AiEvaluation" ("slotKey")
  WHERE state IN ('queued','retry_wait');
--> statement-breakpoint
CREATE INDEX "AiEvaluation_slot_history_idx" ON "AiEvaluation" ("slotKey", "createdAt", "id");
--> statement-breakpoint
DROP INDEX "AiEvaluation_pending_share_key";
--> statement-breakpoint
CREATE INDEX "AiEvaluation_pending_share_key" ON "AiEvaluation" ("shareKey")
  WHERE "shareKey" IS NOT NULL AND state IN ('queued','running','result_ready','retry_wait');
--> statement-breakpoint
-- derived:begin
CREATE OR REPLACE FUNCTION derived_mark(p_target text, p_refs uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "DerivedDirty" (target, ref, priority)
    SELECT DISTINCT p_target, r, 0 FROM unnest(p_refs) AS r WHERE r IS NOT NULL
  ON CONFLICT (target, ref) DO UPDATE SET
    ticket = nextval('"DerivedTicket"'),
    priority = LEAST("DerivedDirty".priority, EXCLUDED.priority),
    "readyAt" = now(),
    attempts = 0,
    "lastError" = NULL;
  IF current_setting('cubby.derived_capture', true) IS DISTINCT FROM txid_current()::text THEN
    INSERT INTO "JobInvalidationCapture" (key, "capturedAt")
      VALUES ('derived:drain', now() AT TIME ZONE 'UTC');
    PERFORM set_config('cubby.derived_capture', txid_current()::text, true);
  END IF;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_cookbook() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Cookbook_derived_mark" ON "Cookbook";--> statement-breakpoint
CREATE TRIGGER "Cookbook_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Cookbook"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_cookbook();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_dataexception() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'recipe' OR NEW."entityKind" = 'recipe') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'ingredient' OR NEW."entityKind" = 'ingredient') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'cookbook' OR NEW."entityKind" = 'cookbook') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' THEN PERFORM derived_mark('location.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' THEN PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'location' OR NEW."entityKind" = 'location') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'inventory' OR NEW."entityKind" = 'inventory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'meal' THEN PERFORM derived_mark('meal.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'meal' THEN PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'meal' OR NEW."entityKind" = 'meal') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ledgerParty' THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ledgerParty' THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'ledgerParty' OR NEW."entityKind" = 'ledgerParty') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ledgerTransfer' THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ledgerTransfer' THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'ledgerTransfer' OR NEW."entityKind" = 'ledgerTransfer') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'project' THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'project' THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'project' OR NEW."entityKind" = 'project') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'task' THEN PERFORM derived_mark('task.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'task' THEN PERFORM derived_mark('task.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'task' OR NEW."entityKind" = 'task') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'vendor' OR NEW."entityKind" = 'vendor') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'financialAccount' OR NEW."entityKind" = 'financialAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'wish' THEN PERFORM derived_mark('wish.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'wish' THEN PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'wish' OR NEW."entityKind" = 'wish') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'expense' THEN PERFORM derived_mark('expense.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'expense' THEN PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'expense' OR NEW."entityKind" = 'expense') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'image' OR NEW."entityKind" = 'image') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'planting' THEN PERFORM derived_mark('planting.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'planting' THEN PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'planting' OR NEW."entityKind" = 'planting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'gardenEntry' OR NEW."entityKind" = 'gardenEntry') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'productCategory' THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'productCategory' THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'productCategory' OR NEW."entityKind" = 'productCategory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'run' THEN PERFORM derived_mark('run.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'run' THEN PERFORM derived_mark('run.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'run' OR NEW."entityKind" = 'run') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('run.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'device' THEN PERFORM derived_mark('device.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'device' THEN PERFORM derived_mark('device.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'device' OR NEW."entityKind" = 'device') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('device.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'plant' THEN PERFORM derived_mark('plant.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'plant' THEN PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'plant' OR NEW."entityKind" = 'plant') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'spendingCategory' THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'spendingCategory' THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'spendingCategory' OR NEW."entityKind" = 'spendingCategory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'email' THEN PERFORM derived_mark('email.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'email' THEN PERFORM derived_mark('email.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'email' OR NEW."entityKind" = 'email') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'imageJob' THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'imageJob' THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'imageJob' OR NEW."entityKind" = 'imageJob') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'shipment' OR NEW."entityKind" = 'shipment') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "DataException_derived_mark" ON "DataException";--> statement-breakpoint
CREATE TRIGGER "DataException_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "DataException"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_dataexception();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_device() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('device.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Device_derived_mark" ON "Device";--> statement-breakpoint
CREATE TRIGGER "Device_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Device"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_device();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_email() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Email_derived_mark" ON "Email";--> statement-breakpoint
CREATE TRIGGER "Email_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Email"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_email();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_emailcandidateobservation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[NEW."emailId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[OLD."emailId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality', ARRAY[OLD."emailId"::uuid] || ARRAY[NEW."emailId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "EmailCandidateObservation_derived_mark" ON "EmailCandidateObservation";--> statement-breakpoint
CREATE TRIGGER "EmailCandidateObservation_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "EmailCandidateObservation"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_emailcandidateobservation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_emailclassificationobservation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[NEW."emailId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality', ARRAY[OLD."emailId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality', ARRAY[OLD."emailId"::uuid] || ARRAY[NEW."emailId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "EmailClassificationObservation_derived_mark" ON "EmailClassificationObservation";--> statement-breakpoint
CREATE TRIGGER "EmailClassificationObservation_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "EmailClassificationObservation"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_emailclassificationobservation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entityattachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'recipe' OR NEW."entityKind" = 'recipe') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'recipe' OR NEW."entityKind" = 'recipe') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'ingredient' OR NEW."entityKind" = 'ingredient') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'ingredient' OR NEW."entityKind" = 'ingredient') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'cookbook' OR NEW."entityKind" = 'cookbook') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'cookbook' OR NEW."entityKind" = 'cookbook') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' THEN PERFORM derived_mark('location.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' THEN PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'location' OR NEW."entityKind" = 'location') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' THEN PERFORM derived_mark('location.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' THEN PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'location' OR NEW."entityKind" = 'location') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'inventory' OR NEW."entityKind" = 'inventory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'inventory' OR NEW."entityKind" = 'inventory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'meal' THEN PERFORM derived_mark('meal.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'meal' THEN PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'meal' OR NEW."entityKind" = 'meal') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'meal' THEN PERFORM derived_mark('meal.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'meal' THEN PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'meal' OR NEW."entityKind" = 'meal') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ledgerParty' THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ledgerParty' THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'ledgerParty' OR NEW."entityKind" = 'ledgerParty') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ledgerTransfer' THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ledgerTransfer' THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'ledgerTransfer' OR NEW."entityKind" = 'ledgerTransfer') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'project' THEN PERFORM derived_mark('project.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'project' THEN PERFORM derived_mark('project.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'project' OR NEW."entityKind" = 'project') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'project' THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'project' THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'project' OR NEW."entityKind" = 'project') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'task' THEN PERFORM derived_mark('task.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'task' THEN PERFORM derived_mark('task.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'task' OR NEW."entityKind" = 'task') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'task' THEN PERFORM derived_mark('task.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'task' THEN PERFORM derived_mark('task.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'task' OR NEW."entityKind" = 'task') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'vendor' OR NEW."entityKind" = 'vendor') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'vendor' OR NEW."entityKind" = 'vendor') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'financialAccount' OR NEW."entityKind" = 'financialAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'financialAccount' OR NEW."entityKind" = 'financialAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'wish' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'wish' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'wish' OR NEW."entityKind" = 'wish') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'wish' THEN PERFORM derived_mark('wish.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'wish' THEN PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'wish' OR NEW."entityKind" = 'wish') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'expense' THEN PERFORM derived_mark('expense.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'expense' THEN PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'expense' OR NEW."entityKind" = 'expense') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'expense' THEN PERFORM derived_mark('expense.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'expense' THEN PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'expense' OR NEW."entityKind" = 'expense') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'image' OR NEW."entityKind" = 'image') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'image' OR NEW."entityKind" = 'image') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."imageId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid] || ARRAY[NEW."imageId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'planting' THEN PERFORM derived_mark('planting.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'planting' THEN PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'planting' OR NEW."entityKind" = 'planting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'planting' THEN PERFORM derived_mark('planting.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'planting' THEN PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'planting' OR NEW."entityKind" = 'planting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'gardenEntry' OR NEW."entityKind" = 'gardenEntry') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'gardenEntry' OR NEW."entityKind" = 'gardenEntry') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'productCategory' THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'productCategory' THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'productCategory' OR NEW."entityKind" = 'productCategory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'run' THEN PERFORM derived_mark('run.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'run' THEN PERFORM derived_mark('run.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'run' OR NEW."entityKind" = 'run') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('run.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'device' THEN PERFORM derived_mark('device.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'device' THEN PERFORM derived_mark('device.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'device' OR NEW."entityKind" = 'device') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('device.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'plant' THEN PERFORM derived_mark('plant.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'plant' THEN PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'plant' OR NEW."entityKind" = 'plant') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'plant' THEN PERFORM derived_mark('plant.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'plant' THEN PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'plant' OR NEW."entityKind" = 'plant') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'spendingCategory' THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'spendingCategory' THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'spendingCategory' OR NEW."entityKind" = 'spendingCategory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'email' THEN PERFORM derived_mark('email.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'email' THEN PERFORM derived_mark('email.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'email' OR NEW."entityKind" = 'email') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'imageJob' THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'imageJob' THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'imageJob' OR NEW."entityKind" = 'imageJob') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'sourceTransactionRecord' OR NEW."entityKind" = 'sourceTransactionRecord') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'transactionImport' THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'transactionImport' THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'transactionImport' OR NEW."entityKind" = 'transactionImport') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'shipment' OR NEW."entityKind" = 'shipment') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'shipment' OR NEW."entityKind" = 'shipment') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "EntityAttachment_derived_mark" ON "EntityAttachment";--> statement-breakpoint
CREATE TRIGGER "EntityAttachment_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "EntityAttachment"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_entityattachment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entityexternalid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('inventory.searchDocument@5', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('inventory.searchDocument@5', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "EntityExternalId_derived_mark" ON "EntityExternalId";--> statement-breakpoint
CREATE TRIGGER "EntityExternalId_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "EntityExternalId"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_entityexternalid();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entitylink() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "EntityLink_derived_mark" ON "EntityLink";--> statement-breakpoint
CREATE TRIGGER "EntityLink_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "EntityLink"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_entitylink();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_expense() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@6', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@6', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."projectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."projectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Expense_derived_mark" ON "Expense";--> statement-breakpoint
CREATE TRIGGER "Expense_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_expense();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_financialaccount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "FinancialAccount_derived_mark" ON "FinancialAccount";--> statement-breakpoint
CREATE TRIGGER "FinancialAccount_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "FinancialAccount"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_financialaccount();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_financialtransaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "FinancialTransaction_derived_mark" ON "FinancialTransaction";--> statement-breakpoint
CREATE TRIGGER "FinancialTransaction_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "FinancialTransaction"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_financialtransaction();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_gardenentry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "GardenEntry_derived_mark" ON "GardenEntry";--> statement-breakpoint
CREATE TRIGGER "GardenEntry_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "GardenEntry"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_gardenentry();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_image() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('product.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('recipe.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('location.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('inventory.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('meal.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('project.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('task.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('vendor.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('vendor.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('purchase.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('wish.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('expense.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('image.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('image.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('planting.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('run.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('device.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('plant.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('email.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('shipment.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('shipment.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Image_derived_mark" ON "Image";--> statement-breakpoint
CREATE TRIGGER "Image_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Image"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_image();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_imageprocessingjob() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "ImageProcessingJob_derived_mark" ON "ImageProcessingJob";--> statement-breakpoint
CREATE TRIGGER "ImageProcessingJob_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "ImageProcessingJob"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_imageprocessingjob();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ingredient() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Ingredient_derived_mark" ON "Ingredient";--> statement-breakpoint
CREATE TRIGGER "Ingredient_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Ingredient"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_ingredient();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_inventoryentry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."locationId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."locationId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."locationId", OLD."placement", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."locationId", NEW."placement", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."locationId"::uuid] || ARRAY[NEW."locationId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "InventoryEntry_derived_mark" ON "InventoryEntry";--> statement-breakpoint
CREATE TRIGGER "InventoryEntry_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "InventoryEntry"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_inventoryentry();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ledgerparty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "LedgerParty_derived_mark" ON "LedgerParty";--> statement-breakpoint
CREATE TRIGGER "LedgerParty_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "LedgerParty"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_ledgerparty();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ledgertransfer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "LedgerTransfer_derived_mark" ON "LedgerTransfer";--> statement-breakpoint
CREATE TRIGGER "LedgerTransfer_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "LedgerTransfer"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_ledgertransfer();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."parentId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."parentId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."parentId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."parentId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."parentId"::uuid] || ARRAY[NEW."parentId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Location_derived_mark" ON "Location";--> statement-breakpoint
CREATE TRIGGER "Location_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Location"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_location();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_meal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Meal_derived_mark" ON "Meal";--> statement-breakpoint
CREATE TRIGGER "Meal_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Meal"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_meal();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_mealrecipe() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[NEW."mealId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."mealId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."mealId"::uuid] || ARRAY[NEW."mealId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "MealRecipe_derived_mark" ON "MealRecipe";--> statement-breakpoint
CREATE TRIGGER "MealRecipe_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "MealRecipe"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_mealrecipe();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ordermail() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "OrderMail_derived_mark" ON "OrderMail";--> statement-breakpoint
CREATE TRIGGER "OrderMail_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "OrderMail"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_ordermail();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ordermailattachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@5', ARRAY[NEW."orderMailId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@5', ARRAY[OLD."orderMailId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@5', ARRAY[OLD."orderMailId"::uuid] || ARRAY[NEW."orderMailId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "OrderMailAttachment_derived_mark" ON "OrderMailAttachment";--> statement-breakpoint
CREATE TRIGGER "OrderMailAttachment_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "OrderMailAttachment"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_ordermailattachment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_plant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Plant_derived_mark" ON "Plant";--> statement-breakpoint
CREATE TRIGGER "Plant_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Plant"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_plant();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_planting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Planting_derived_mark" ON "Planting";--> statement-breakpoint
CREATE TRIGGER "Planting_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Planting"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_planting();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_product() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."ingredientId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@1', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@1', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Product_derived_mark" ON "Product";--> statement-breakpoint
CREATE TRIGGER "Product_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_product();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_productcategory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@11', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@11', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "ProductCategory_derived_mark" ON "ProductCategory";--> statement-breakpoint
CREATE TRIGGER "ProductCategory_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "ProductCategory"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_productcategory();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_productunitmapping() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@3', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@3', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals@3', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@2', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@2', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@2', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "ProductUnitMapping_derived_mark" ON "ProductUnitMapping";--> statement-breakpoint
CREATE TRIGGER "ProductUnitMapping_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "ProductUnitMapping"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_productunitmapping();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."startDate", OLD."endDate", OLD."status", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."startDate", NEW."endDate", NEW."status", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."parentProjectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."parentProjectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."parentProjectId", OLD."startDate", OLD."endDate", OLD."status", OLD."deletedAt") IS DISTINCT FROM (NEW."parentProjectId", NEW."startDate", NEW."endDate", NEW."status", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."parentProjectId"::uuid] || ARRAY[NEW."parentProjectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."startDate", OLD."endDate", OLD."status", OLD."parentProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."startDate", NEW."endDate", NEW."status", NEW."parentProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."parentProjectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."parentProjectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."parentProjectId", OLD."startDate", OLD."endDate", OLD."status", OLD."deletedAt") IS DISTINCT FROM (NEW."parentProjectId", NEW."startDate", NEW."endDate", NEW."status", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."parentProjectId"::uuid] || ARRAY[NEW."parentProjectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Project_derived_mark" ON "Project";--> statement-breakpoint
CREATE TRIGGER "Project_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Project"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_project();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_purchase() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."defaultProjectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."defaultProjectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."defaultProjectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."defaultProjectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Purchase_derived_mark" ON "Purchase";--> statement-breakpoint
CREATE TRIGGER "Purchase_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Purchase"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_purchase();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_recipe() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt', 'totals', 'totalsComputedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt', 'totals', 'totalsComputedAt']) THEN
    PERFORM derived_mark('recipe.totals', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Recipe_derived_mark" ON "Recipe";--> statement-breakpoint
CREATE TRIGGER "Recipe_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Recipe"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_recipe();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_recipesection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals', ARRAY[NEW."recipeId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals', ARRAY[OLD."recipeId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals', ARRAY[OLD."recipeId"::uuid] || ARRAY[NEW."recipeId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[NEW."recipeId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."recipeId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."recipeId"::uuid] || ARRAY[NEW."recipeId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "RecipeSection_derived_mark" ON "RecipeSection";--> statement-breakpoint
CREATE TRIGGER "RecipeSection_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "RecipeSection"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_recipesection();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_recipesectioningredient() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@2', ARRAY[NEW."recipeSectionId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@2', ARRAY[OLD."recipeSectionId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals@2', ARRAY[OLD."recipeSectionId"::uuid] || ARRAY[NEW."recipeSectionId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "RecipeSectionIngredient_derived_mark" ON "RecipeSectionIngredient";--> statement-breakpoint
CREATE TRIGGER "RecipeSectionIngredient_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "RecipeSectionIngredient"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_recipesectioningredient();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('run.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."purpose" = 'mail_import' THEN PERFORM derived_mark('email.dataQuality@8', ARRAY(SELECT (e->>'orderMailId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW."input" #> '{sources}') = 'array' THEN NEW."input" #> '{sources}' ELSE '[]'::jsonb END) AS e WHERE e->>'orderMailId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."purpose" = 'mail_import' THEN PERFORM derived_mark('email.dataQuality@8', ARRAY(SELECT (e->>'orderMailId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD."input" #> '{sources}') = 'array' THEN OLD."input" #> '{sources}' ELSE '[]'::jsonb END) AS e WHERE e->>'orderMailId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')); END IF;
  ELSIF (OLD."purpose" = 'mail_import' OR NEW."purpose" = 'mail_import') AND (OLD."input", OLD."status", OLD."deletedAt", OLD."ledgerPartyId") IS DISTINCT FROM (NEW."input", NEW."status", NEW."deletedAt", NEW."ledgerPartyId") THEN
    PERFORM derived_mark('email.dataQuality@8', ARRAY(SELECT (e->>'orderMailId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD."input" #> '{sources}') = 'array' THEN OLD."input" #> '{sources}' ELSE '[]'::jsonb END) AS e WHERE e->>'orderMailId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'orderMailId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW."input" #> '{sources}') = 'array' THEN NEW."input" #> '{sources}' ELSE '[]'::jsonb END) AS e WHERE e->>'orderMailId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Run_derived_mark" ON "Run";--> statement-breakpoint
CREATE TRIGGER "Run_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Run"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_run();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_runoperation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality', ARRAY[NEW."runId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality', ARRAY[OLD."runId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('run.dataQuality', ARRAY[OLD."runId"::uuid] || ARRAY[NEW."runId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "RunOperation_derived_mark" ON "RunOperation";--> statement-breakpoint
CREATE TRIGGER "RunOperation_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "RunOperation"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_runoperation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_shipment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Shipment_derived_mark" ON "Shipment";--> statement-breakpoint
CREATE TRIGGER "Shipment_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Shipment"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_shipment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_shipmentobservation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[NEW."shipmentId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."shipmentId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."shipmentId"::uuid] || ARRAY[NEW."shipmentId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "ShipmentObservation_derived_mark" ON "ShipmentObservation";--> statement-breakpoint
CREATE TRIGGER "ShipmentObservation_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "ShipmentObservation"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_shipmentobservation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_sourcetransactionrecord() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "SourceTransactionRecord_derived_mark" ON "SourceTransactionRecord";--> statement-breakpoint
CREATE TRIGGER "SourceTransactionRecord_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "SourceTransactionRecord"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_sourcetransactionrecord();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_spendingcategory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "SpendingCategory_derived_mark" ON "SpendingCategory";--> statement-breakpoint
CREATE TRIGGER "SpendingCategory_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "SpendingCategory"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_spendingcategory();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_task() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."projectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."projectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."dueDate", OLD."dueEndDate", OLD."status", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."dueDate", NEW."dueEndDate", NEW."status", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Task_derived_mark" ON "Task";--> statement-breakpoint
CREATE TRIGGER "Task_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Task"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_task();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_transactionimport() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "TransactionImport_derived_mark" ON "TransactionImport";--> statement-breakpoint
CREATE TRIGGER "TransactionImport_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "TransactionImport"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_transactionimport();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_vendor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Vendor_derived_mark" ON "Vendor";--> statement-breakpoint
CREATE TRIGGER "Vendor_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Vendor"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_vendor();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_wish() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Wish_derived_mark" ON "Wish";--> statement-breakpoint
CREATE TRIGGER "Wish_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Wish"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_wish();--> statement-breakpoint
CREATE OR REPLACE FUNCTION job_never_exhausted_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IN ('derived.drain', 'derived.reconcile', 'image.cloud',
    'image.device', 'image.device.wake', 'jobs.retention', 'queue.watchdog') THEN
    NEW.state := 'retry_wait';
    NEW."leaseToken" := NULL;
    NEW."leaseExpiresAt" := NULL;
    NEW."availableAt" := greatest(NEW."availableAt", now() + interval '1 minute');
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DELETE FROM "JobInvalidationCapture" WHERE key LIKE 'refresh:%';--> statement-breakpoint
DELETE FROM "JobInvalidation" WHERE key LIKE 'refresh:%';--> statement-breakpoint
DELETE FROM "Job" WHERE kind = 'refresh.family';--> statement-breakpoint
INSERT INTO "Job" (key, kind, input, state) VALUES ('derived:drain', 'derived.drain', '{}'::jsonb, 'queued'), ('derived:reconcile', 'derived.reconcile', '{}'::jsonb, 'completed') ON CONFLICT (key) DO NOTHING;--> statement-breakpoint
INSERT INTO "JobInvalidation" (key, "restartsPass") VALUES ('derived:drain', false) ON CONFLICT (key) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'product.price', t.id, 1 FROM "Product" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'product.ledgerExpectedQuantity', t.id, 1 FROM "Product" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'product.quantityVariance', t.id, 1 FROM "Product" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'product.conversionCoverage', t.id, 1 FROM "Product" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'product.searchDocument', t.id, 1 FROM "Product" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'product.dataQuality', t.id, 1 FROM "Product" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'recipe.totals', t.id, 1 FROM "Recipe" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'recipe.searchDocument', t.id, 1 FROM "Recipe" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'recipe.dataQuality', t.id, 1 FROM "Recipe" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'ingredient.searchDocument', t.id, 1 FROM "Ingredient" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'ingredient.dataQuality', t.id, 1 FROM "Ingredient" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'cookbook.searchDocument', t.id, 1 FROM "Cookbook" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'cookbook.dataQuality', t.id, 1 FROM "Cookbook" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'location.valuationRollup', t.id, 1 FROM "Location" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'location.searchDocument', t.id, 1 FROM "Location" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'location.dataQuality', t.id, 1 FROM "Location" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'inventory.valuation', t.id, 1 FROM "InventoryEntry" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'inventory.searchDocument', t.id, 1 FROM "InventoryEntry" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'inventory.dataQuality', t.id, 1 FROM "InventoryEntry" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'meal.searchDocument', t.id, 1 FROM "Meal" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'meal.dataQuality', t.id, 1 FROM "Meal" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'ledgerParty.dataQuality', t.id, 1 FROM "LedgerParty" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'ledgerTransfer.dataQuality', t.id, 1 FROM "LedgerTransfer" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'project.startDate', t.id, 1 FROM "Project" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'project.completionYear', t.id, 1 FROM "Project" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'project.searchDocument', t.id, 1 FROM "Project" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'project.dataQuality', t.id, 1 FROM "Project" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'task.searchDocument', t.id, 1 FROM "Task" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'task.dataQuality', t.id, 1 FROM "Task" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'vendor.searchDocument', t.id, 1 FROM "Vendor" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'vendor.dataQuality', t.id, 1 FROM "Vendor" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'purchase.searchDocument', t.id, 1 FROM "Purchase" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'purchase.dataQuality', t.id, 1 FROM "Purchase" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'financialAccount.searchDocument', t.id, 1 FROM "FinancialAccount" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'financialAccount.dataQuality', t.id, 1 FROM "FinancialAccount" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'financialTransaction.searchDocument', t.id, 1 FROM "FinancialTransaction" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'financialTransaction.dataQuality', t.id, 1 FROM "FinancialTransaction" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'wish.searchDocument', t.id, 1 FROM "Wish" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'wish.dataQuality', t.id, 1 FROM "Wish" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'expense.searchDocument', t.id, 1 FROM "Expense" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'expense.dataQuality', t.id, 1 FROM "Expense" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'image.searchDocument', t.id, 1 FROM "Image" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'image.dataQuality', t.id, 1 FROM "Image" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'planting.searchDocument', t.id, 1 FROM "Planting" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'planting.dataQuality', t.id, 1 FROM "Planting" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'gardenEntry.searchDocument', t.id, 1 FROM "GardenEntry" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'gardenEntry.dataQuality', t.id, 1 FROM "GardenEntry" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'productCategory.dataQuality', t.id, 1 FROM "ProductCategory" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'run.dataQuality', t.id, 1 FROM "Run" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'device.dataQuality', t.id, 1 FROM "Device" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'plant.searchDocument', t.id, 1 FROM "Plant" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'plant.dataQuality', t.id, 1 FROM "Plant" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'spendingCategory.dataQuality', t.id, 1 FROM "SpendingCategory" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'email.dataQuality', t.id, 1 FROM "Email" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'imageJob.dataQuality', t.id, 1 FROM "ImageProcessingJob" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'sourceTransactionRecord.searchDocument', t.id, 1 FROM "SourceTransactionRecord" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'transactionImport.searchDocument', t.id, 1 FROM "TransactionImport" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'shipment.searchDocument', t.id, 1 FROM "Shipment" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'shipment.dataQuality', t.id, 1 FROM "Shipment" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
-- derived:end
