CREATE TABLE "ConnectionCandidateEvidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"scopeKey" text NOT NULL,
	"fingerprint" text NOT NULL CONSTRAINT "ConnectionCandidateEvidence_fingerprint_key" UNIQUE,
	"sourceEntity" text NOT NULL,
	"sourceId" uuid NOT NULL,
	"targetEntity" text NOT NULL,
	"targetId" uuid NOT NULL,
	"candidate" jsonb NOT NULL,
	"basis" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ConnectionCandidateEvidence_scope_idx" ON "ConnectionCandidateEvidence" ("scopeKey");