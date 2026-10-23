CREATE TABLE "PhotoGroupSourceEvidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"groupKey" text NOT NULL,
	"sourceManufacturer" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "PhotoGroupSourceEvidence" ADD CONSTRAINT "PhotoGroupSourceEvidence_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "PhotoGroupSourceEvidence_runId_idx" ON "PhotoGroupSourceEvidence" USING btree ("runId");