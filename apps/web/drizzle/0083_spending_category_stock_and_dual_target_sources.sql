ALTER TABLE "EntitySource" DROP CONSTRAINT "EntitySource_one_target_check";--> statement-breakpoint
ALTER TABLE "SpendingCategory" ADD COLUMN "stockTracked" boolean;