ALTER TABLE "AiEvaluation" ADD COLUMN "failingSince" timestamp;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "deletionFailingSince" timestamp;--> statement-breakpoint
ALTER TABLE "SearchDocument" ADD COLUMN "embeddingFailingSince" timestamp;