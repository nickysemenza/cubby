ALTER TABLE "Job" ADD COLUMN "recoveryTimeoutMs" integer;--> statement-breakpoint
ALTER TABLE "Job" ADD COLUMN "lastUsefulProgressAt" timestamp;