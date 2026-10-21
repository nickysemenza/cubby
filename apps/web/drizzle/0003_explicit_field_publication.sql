-- Contract cutover: deploy explicit field publishers and drain old attempts before
-- applying this migration. Hold automatic migrations through 0002 while deploying;
-- docs/runbooks/production-migrations.md owns the staged boundary procedure.
DROP TRIGGER IF EXISTS "AssessmentState_publish_field" ON "AssessmentState";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "publish_field_assessment"();
