CREATE TABLE "ProductIdentityObservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"scopeKey" text NOT NULL,
	"userId" text NOT NULL,
	"payload" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ProductIdentityObservation_scope_idx" ON "ProductIdentityObservation" ("scopeKey");