-- Additive expansion. Safe with the previous application version; run before deployment.
BEGIN;
CREATE TABLE IF NOT EXISTS "ImageProcessingSubmission" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "publicId" text NOT NULL DEFAULT ('IPS-' || upper(replace(gen_random_uuid()::text, '-', ''))),
 "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ImageProcessingSubmission_publicId_key" ON "ImageProcessingSubmission" ("publicId");
ALTER TABLE "ImageProcessingJob" ADD COLUMN IF NOT EXISTS "publicId" text NOT NULL DEFAULT ('IPR-' || upper(replace(gen_random_uuid()::text, '-', '')));
ALTER TABLE "ImageProcessingJob" ADD COLUMN IF NOT EXISTS "submissionId" uuid REFERENCES "ImageProcessingSubmission"(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ImageProcessingJob_publicId_key" ON "ImageProcessingJob" ("publicId");
ALTER TABLE "ImportRunOperation" ADD COLUMN IF NOT EXISTS executor jsonb;
CREATE TABLE IF NOT EXISTS "ImageProcessingAttempt" (
 id uuid PRIMARY KEY,
 "jobId" uuid NOT NULL REFERENCES "ImageProcessingJob"(id) ON DELETE CASCADE,
 number integer NOT NULL,
 "submissionId" uuid REFERENCES "ImageProcessingSubmission"(id) ON DELETE SET NULL,
 "inputKey" text,
 state text NOT NULL,
 executor jsonb,
 "assignedUserId" text,
 "assignedConnectionId" text,
 diagnostics jsonb,
 result jsonb,
 error text,
 "startedAt" timestamp NOT NULL DEFAULT now(),
 "completedAt" timestamp,
 CONSTRAINT "ImageProcessingAttempt_number_check" CHECK (number > 0),
 CONSTRAINT "ImageProcessingAttempt_state_check" CHECK (state IN ('leased','running','waiting','expired','ready','skipped','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "ImageProcessingAttempt_job_number_key" ON "ImageProcessingAttempt" ("jobId",number);
CREATE INDEX IF NOT EXISTS "ImageProcessingAttempt_device_idx" ON "ImageProcessingAttempt" ((executor->>'deviceId'));
CREATE INDEX IF NOT EXISTS "ImageProcessingAttempt_submission_idx" ON "ImageProcessingAttempt" ("submissionId");
CREATE TABLE IF NOT EXISTS "ImageProcessingEvent" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "jobId" uuid NOT NULL REFERENCES "ImageProcessingJob"(id) ON DELETE CASCADE,
 "eventKey" text NOT NULL,
 attempt integer,
 event text NOT NULL,
 level text NOT NULL DEFAULT 'info',
 source text NOT NULL DEFAULT 'server',
 details jsonb,
 "occurredAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ImageProcessingEvent_job_event_key" ON "ImageProcessingEvent" ("jobId","eventKey");
CREATE INDEX IF NOT EXISTS "ImageProcessingEvent_job_time_idx" ON "ImageProcessingEvent" ("jobId","occurredAt",id);
CREATE TABLE IF NOT EXISTS "ImageProcessingSubmissionJob" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "submissionId" uuid NOT NULL REFERENCES "ImageProcessingSubmission"(id) ON DELETE CASCADE,
 "jobId" uuid NOT NULL REFERENCES "ImageProcessingJob"(id) ON DELETE CASCADE,
 disposition text NOT NULL,
 "baselineAttempts" integer NOT NULL,
 CONSTRAINT "ImageProcessingSubmissionJob_disposition_check" CHECK (disposition IN ('new','reused','running','retry')),
 CONSTRAINT "ImageProcessingSubmissionJob_baseline_check" CHECK ("baselineAttempts" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "ImageProcessingSubmissionJob_membership_key" ON "ImageProcessingSubmissionJob" ("submissionId","jobId");
COMMIT;
