-- Expand for the `jev` -> `decision` classification stage rename: both values
-- are valid until 0042 rewrites the rows after the new code deploys.

ALTER TABLE "Email" DROP CONSTRAINT "Email_classification_stage_check";--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" DROP CONSTRAINT "EmailClassificationObservation_stage_check";--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_classification_stage_check" CHECK ("classificationStage" IS NULL OR "classificationStage" IN ('rule', 'jev', 'decision', 'model', 'resolution'));--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD CONSTRAINT "EmailClassificationObservation_stage_check" CHECK ("EmailClassificationObservation"."stage" IN ('rule', 'jev', 'decision', 'model', 'resolution'));