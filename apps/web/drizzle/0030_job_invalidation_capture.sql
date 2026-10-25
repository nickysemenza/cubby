-- No backfill: work already pending at cutover dates from its marker's last
-- write, as before; every later capture records its own time here.
CREATE TABLE "JobInvalidationCapture" (
	"key" text NOT NULL,
	"revision" bigint NOT NULL,
	"capturedAt" timestamp NOT NULL,
	CONSTRAINT "JobInvalidationCapture_key_revision_pk" PRIMARY KEY("key","revision")
);
