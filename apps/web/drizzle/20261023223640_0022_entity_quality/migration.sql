CREATE TABLE "EntityQuality" (
	"entityId" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"score" double precision,
	"rulesVersion" integer NOT NULL,
	"computedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "EntityQualityCheck" (
	"entityId" uuid NOT NULL,
	"kind" text NOT NULL,
	"checkKey" text NOT NULL,
	"state" text NOT NULL,
	CONSTRAINT "EntityQualityCheck_entityId_checkKey_pk" PRIMARY KEY("entityId","checkKey"),
	CONSTRAINT "EntityQualityCheck_state_check" CHECK ("EntityQualityCheck"."state" IN ('pass', 'gap', 'waived', 'not_applicable'))
);
--> statement-breakpoint
ALTER TABLE "EntityQuality" ADD CONSTRAINT "EntityQuality_entity_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EntityQualityCheck" ADD CONSTRAINT "EntityQualityCheck_entity_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "EntityQualityCheck_kind_check_state_idx" ON "EntityQualityCheck" USING btree ("kind","checkKey","state");--> statement-breakpoint
ALTER TABLE "DataException" DROP COLUMN "fingerprint";
