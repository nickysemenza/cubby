ALTER TABLE "WorkItem" ADD COLUMN "executionLeaseToken" uuid;--> statement-breakpoint
ALTER TABLE "WorkItem" ADD COLUMN "executionTicket" bigint;--> statement-breakpoint
ALTER TABLE "WorkItem" ADD COLUMN "executionStartedAt" timestamp;