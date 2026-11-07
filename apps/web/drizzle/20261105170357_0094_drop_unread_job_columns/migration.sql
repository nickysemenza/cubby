-- cubby:transaction-per-statement
-- See 0073 for how this mode behaves against live writers.
-- Nothing writes or reads these. Record pages find their Jobs by key, and no executor has
-- recorded a lease holder since images left Job.
ALTER TABLE "Job" DROP CONSTRAINT IF EXISTS "Job_subject_check";--> statement-breakpoint
DROP INDEX IF EXISTS "Job_subject_idx";--> statement-breakpoint
ALTER TABLE "Job" DROP COLUMN IF EXISTS "subjectKind", DROP COLUMN IF EXISTS "subjectId", DROP COLUMN IF EXISTS "leaseHolder";
