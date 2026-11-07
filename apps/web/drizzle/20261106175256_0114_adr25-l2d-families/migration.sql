-- Only serialization keys lived here; there are no domain facts or decisions.
LOCK TABLE "AssessmentCorrectionLock" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DROP TABLE "AssessmentCorrectionLock";
