CREATE TABLE "PhotoInventoryEvidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"locationId" uuid NOT NULL,
	"runId" uuid,
	"fingerprint" text NOT NULL CONSTRAINT "PhotoInventoryEvidence_fingerprint_key" UNIQUE,
	"sourceSnapshot" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "PhotoInventoryEvidence" ADD CONSTRAINT "PhotoInventoryEvidence_locationId_Location_id_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id");--> statement-breakpoint
ALTER TABLE "PhotoInventoryEvidence" ADD CONSTRAINT "PhotoInventoryEvidence_runId_Run_id_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id");