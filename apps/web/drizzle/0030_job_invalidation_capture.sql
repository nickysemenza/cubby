CREATE TABLE "JobInvalidationCapture" (
	"key" text NOT NULL,
	"revision" bigint NOT NULL,
	"capturedAt" timestamp NOT NULL,
	CONSTRAINT "JobInvalidationCapture_key_revision_pk" PRIMARY KEY("key","revision")
);
--> statement-breakpoint
-- A marker already ahead of its Job at the cutover has no capture history;
-- its last write is the best known start of that outstanding work, so it is
-- recorded as the capture of its current revision. Without it the next
-- capture would replace the marker's write time and the legacy pending age
-- would be lost. The lock holds captures (marker upserts) back until this
-- transaction commits, so no capture lands between the read and the insert;
-- readers continue.
LOCK TABLE "JobInvalidation" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
INSERT INTO "JobInvalidationCapture" (key, revision, "capturedAt")
SELECT m.key, m.revision, m."updatedAt"
FROM "JobInvalidation" m
LEFT JOIN "Job" j ON j.key = m.key
WHERE m.revision > coalesce(j."observedRevision", 0)
ON CONFLICT DO NOTHING;
