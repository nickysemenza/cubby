CREATE TABLE "ShipmentPackageObservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"scopeKey" text NOT NULL,
	"sourceKey" text NOT NULL,
	"packageKey" text NOT NULL,
	"actorUserId" text,
	"values" jsonb NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ShipmentPackageObservation_scope_idx" ON "ShipmentPackageObservation" ("scopeKey","createdAt");