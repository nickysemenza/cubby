CREATE TABLE "JobInvalidation" (
	"key" text PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"restartsPass" boolean NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Job" ADD COLUMN "observedRevision" bigint;--> statement-breakpoint
-- Existing refresh families start observed at revision 1, so the first
-- capture after the cutover bumps a marker row and never writes the family's
-- execution row. Pending invalidations already bumped the Job's generation.
INSERT INTO "JobInvalidation" (key, revision, "restartsPass")
SELECT key, 1, coalesce(input->>'family', '') <> 'quality'
FROM "Job" WHERE kind = 'refresh.family'
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint
UPDATE "Job" SET "observedRevision" = 1 WHERE kind = 'refresh.family';
