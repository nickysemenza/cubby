ALTER SEQUENCE "public"."DerivedTicket" RENAME TO "WorkTicket";--> statement-breakpoint
ALTER TABLE "JobInvalidation" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "JobInvalidation" CASCADE;--> statement-breakpoint
ALTER TABLE "DerivedDirty" RENAME TO "WorkItem";--> statement-breakpoint
ALTER TABLE "WorkItem" DROP CONSTRAINT "DerivedDirty_no_retired_automatic_fields";--> statement-breakpoint
ALTER TABLE "Job" DROP CONSTRAINT "Job_kind_retired_check";--> statement-breakpoint
ALTER TABLE "Job" DROP CONSTRAINT "Job_attempts_check";--> statement-breakpoint
DROP INDEX "Job_kind_position_idx";--> statement-breakpoint
ALTER TABLE "WorkItem" DROP CONSTRAINT "DerivedDirty_target_ref_pk";--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ALTER COLUMN "artifactState" SET DEFAULT 'prepared';--> statement-breakpoint
ALTER TABLE "Job" ALTER COLUMN "maxAttempts" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_target_ref_pk" PRIMARY KEY("target","ref");--> statement-breakpoint
ALTER TABLE "Job" DROP COLUMN "recoveryTimeoutMs";--> statement-breakpoint
ALTER TABLE "Job" DROP COLUMN "lastUsefulProgressAt";--> statement-breakpoint
ALTER TABLE "Job" DROP COLUMN "admissionToken";--> statement-breakpoint
ALTER TABLE "WorkItem" ADD CONSTRAINT "DerivedDirty_no_retired_automatic_fields" CHECK (split_part("WorkItem"."target", '@', 1) NOT LIKE '%.automaticFields');--> statement-breakpoint
ALTER TABLE "Job" ADD CONSTRAINT "Job_attempts_check" CHECK ("Job"."attempts" >= 0 AND coalesce("Job"."maxAttempts", 1) > 0);
