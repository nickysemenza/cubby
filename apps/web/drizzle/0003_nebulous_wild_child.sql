CREATE TABLE "ProductExternalId" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"productId" uuid NOT NULL,
	"source" text NOT NULL,
	"externalId" text NOT NULL,
	"url" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
ALTER TABLE "ProductExternalId" ADD CONSTRAINT "ProductExternalId_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ProductExternalId_productId_idx" ON "ProductExternalId" USING btree ("productId");--> statement-breakpoint
CREATE UNIQUE INDEX "ProductExternalId_product_source_key" ON "ProductExternalId" USING btree ("productId","source") WHERE "ProductExternalId"."deletedAt" IS NULL;