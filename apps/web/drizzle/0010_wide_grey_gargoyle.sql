ALTER TABLE "Recipe" ADD COLUMN "totals" jsonb;--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN "totalsComputedAt" timestamp;--> statement-breakpoint
CREATE INDEX "Recipe_totals_stale_idx" ON "Recipe" USING btree ("totalsComputedAt") WHERE "Recipe"."totalsComputedAt" IS NULL;