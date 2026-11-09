ALTER TABLE "EntityEmbedding" ADD COLUMN "deletionAttempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "deletionError" text;--> statement-breakpoint
ALTER TABLE "Job" ADD COLUMN "failingSince" timestamp;--> statement-breakpoint
ALTER TABLE "Job" ADD COLUMN "lastExecution" jsonb;