ALTER TABLE "UpcLookupCache" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "UpcLookupCache" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "UpcLookupCache" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "UpcLookupCache" ADD COLUMN "source" text DEFAULT 'upcitemdb' NOT NULL;--> statement-breakpoint
-- Legacy rows predate `name`, so they cannot answer a lookup. The cache is
-- regenerable from upcitemdb: drop them and let the next lookup refill it.
DELETE FROM "UpcLookupCache";
