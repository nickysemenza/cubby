SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
LOCK TABLE "DerivedValue" IN SHARE MODE;
--> statement-breakpoint
CREATE TABLE "QualitySnapshot" (
	"entityId" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"rulesVersion" integer NOT NULL,
	"checks" jsonb NOT NULL,
	"computedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "QualitySnapshot" ("entityId", kind, "rulesVersion", checks, "computedAt")
SELECT "entityId", kind, (value->>'rulesVersion')::integer, value->'checks', "computedAt"
FROM "DerivedValue" WHERE key = 'dataQuality';
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    (SELECT "entityId", kind, (value->>'rulesVersion')::integer, value->'checks', "computedAt"
      FROM "DerivedValue" WHERE key = 'dataQuality'
     EXCEPT ALL SELECT "entityId", kind, "rulesVersion", checks, "computedAt" FROM "QualitySnapshot")
    UNION ALL
    (SELECT "entityId", kind, "rulesVersion", checks, "computedAt" FROM "QualitySnapshot"
     EXCEPT ALL SELECT "entityId", kind, (value->>'rulesVersion')::integer, value->'checks', "computedAt"
      FROM "DerivedValue" WHERE key = 'dataQuality')
  ) THEN RAISE EXCEPTION 'Quality snapshot carry-forward mismatch'; END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "QualitySnapshot" ADD CONSTRAINT "QualitySnapshot_entity_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_derivedvalue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN

  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION derived_mark_qualitysnapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'product' THEN PERFORM derived_mark('assessment.reviewFacts@100', ARRAY[NEW."entityId"::uuid], 'Quality snapshot created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'product' THEN PERFORM derived_mark('assessment.reviewFacts@100', ARRAY[OLD."entityId"::uuid], 'Quality snapshot removed'); END IF;
  ELSIF (OLD."kind" = 'product' OR NEW."kind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('assessment.reviewFacts@100', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Quality snapshot changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "QualitySnapshot_derived_mark" ON "QualitySnapshot";
CREATE TRIGGER "QualitySnapshot_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "QualitySnapshot"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_qualitysnapshot();
