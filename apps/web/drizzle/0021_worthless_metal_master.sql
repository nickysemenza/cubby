ALTER TABLE "RunEvidence" DROP CONSTRAINT "RunEvidence_kind_check";--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "executionMode" text DEFAULT 'coordinator' NOT NULL;--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_executionMode_check" CHECK ("Run"."executionMode" IN ('coordinator', 'caller'));--> statement-breakpoint
ALTER TABLE "RunEvidence" ADD CONSTRAINT "RunEvidence_kind_check" CHECK ("RunEvidence"."kind" IN ('browser_capture', 'http_capture', 'gmail_attachment', 'manual_upload'));