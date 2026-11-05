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
ALTER TABLE "QualitySnapshot" ADD CONSTRAINT "QualitySnapshot_entity_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE cascade ON UPDATE no action;
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
