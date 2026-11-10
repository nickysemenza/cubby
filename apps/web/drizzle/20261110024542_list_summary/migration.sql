CREATE TABLE "ListSummary" (
	"entity" text,
	"key" text,
	"summary" jsonb NOT NULL,
	"publishedAt" timestamp NOT NULL,
	"dirtyAt" timestamp,
	CONSTRAINT "ListSummary_pkey" PRIMARY KEY("entity","key")
);
--> statement-breakpoint
CREATE INDEX "ListSummary_publishedAt_idx" ON "ListSummary" ("publishedAt");