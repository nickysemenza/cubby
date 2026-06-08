CREATE TABLE "Cookbook" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"author" text[] DEFAULT '{}'::text[] NOT NULL,
	"subjects" text[] DEFAULT '{}'::text[] NOT NULL,
	"sourceLabel" text NOT NULL,
	"rawJson" jsonb NOT NULL,
	"importedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN "cookbookId" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "Cookbook_name_key" ON "Cookbook" USING btree ("name") WHERE "Cookbook"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Cookbook_createdAt_idx" ON "Cookbook" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Cookbook_name_gin_idx" ON "Cookbook" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_cookbookId_Cookbook_id_fk" FOREIGN KEY ("cookbookId") REFERENCES "public"."Cookbook"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Recipe_cookbookId_idx" ON "Recipe" USING btree ("cookbookId");