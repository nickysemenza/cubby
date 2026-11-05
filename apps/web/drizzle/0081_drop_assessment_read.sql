-- The four AssessmentRead tables held derived copies of a read pipeline that no
-- deployed Worker writes or reads. A row here means that Worker is not retired.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $empty$
BEGIN
  IF EXISTS (SELECT 1 FROM "AssessmentReadPublication")
    OR EXISTS (SELECT 1 FROM "AssessmentReadMembership")
    OR EXISTS (SELECT 1 FROM "AssessmentReadDependency")
    OR EXISTS (SELECT 1 FROM "AssessmentReadStage") THEN
    RAISE EXCEPTION 'AssessmentRead tables are not empty';
  END IF;
END $empty$;
--> statement-breakpoint
DROP TABLE "AssessmentReadDependency";
--> statement-breakpoint
DROP TABLE "AssessmentReadMembership";
--> statement-breakpoint
DROP TABLE "AssessmentReadPublication";
--> statement-breakpoint
DROP TABLE "AssessmentReadStage";
