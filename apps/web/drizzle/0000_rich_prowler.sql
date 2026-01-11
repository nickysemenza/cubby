CREATE TYPE "public"."ImageStatus" AS ENUM('PENDING', 'UPLOADED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."RecipeSource" AS ENUM('Book', 'Website', 'Other');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"user_id" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "AppSettings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AuditLog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityType" text NOT NULL,
	"entityId" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb,
	"userId" text NOT NULL,
	"source" text DEFAULT 'ui' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"key" text NOT NULL,
	"filename" text NOT NULL,
	"size" integer NOT NULL,
	"contentType" text NOT NULL,
	"status" "ImageStatus" DEFAULT 'PENDING' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "Ingredient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"recipeId" uuid
);
--> statement-breakpoint
CREATE TABLE "InventoryEntry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"productId" uuid NOT NULL,
	"amount" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"locationId" uuid NOT NULL,
	"valuation" real
);
--> statement-breakpoint
CREATE TABLE "Location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"lastBulkInventory" timestamp,
	"parentId" uuid,
	"type" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "LocationImage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"locationId" uuid NOT NULL,
	"imageId" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "Product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"manufacturer" text NOT NULL,
	"upc" text,
	"ndb_number" integer,
	"model" text,
	"expectedQuantity" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"ingredientId" uuid,
	"category" text,
	"price" real
);
--> statement-breakpoint
CREATE TABLE "ProductImage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"productId" uuid NOT NULL,
	"imageId" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "ProductUnitMappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"productId" uuid NOT NULL,
	"a" jsonb NOT NULL,
	"b" jsonb NOT NULL,
	"source" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "Recipe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text,
	"name" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"SourceType" "RecipeSource",
	"SourceData" text,
	"yield" jsonb,
	"servings" integer,
	"tags" text[]
);
--> statement-breakpoint
CREATE TABLE "RecipeImage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipeId" uuid NOT NULL,
	"imageId" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "RecipeSection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipeId" uuid NOT NULL,
	"name" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"instructions" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "RecipeSectionIngredient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipeSectionId" uuid NOT NULL,
	"ingredientId" uuid NOT NULL,
	"amounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_locationId_Location_id_fk" FOREIGN KEY ("locationId") REFERENCES "public"."Location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LocationImage" ADD CONSTRAINT "LocationImage_locationId_Location_id_fk" FOREIGN KEY ("locationId") REFERENCES "public"."Location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LocationImage" ADD CONSTRAINT "LocationImage_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Product" ADD CONSTRAINT "Product_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductUnitMappings" ADD CONSTRAINT "ProductUnitMappings_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeImage" ADD CONSTRAINT "RecipeImage_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeImage" ADD CONSTRAINT "RecipeImage_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeSection" ADD CONSTRAINT "RecipeSection_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeSectionIngredient" ADD CONSTRAINT "RecipeSectionIngredient_recipeSectionId_RecipeSection_id_fk" FOREIGN KEY ("recipeSectionId") REFERENCES "public"."RecipeSection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeSectionIngredient" ADD CONSTRAINT "RecipeSectionIngredient_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog" USING btree ("createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog" USING btree ("entityType","entityId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "Image_key_key" ON "Image" USING btree ("key") WHERE "Image"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Image_createdAt_idx" ON "Image" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Image_status_idx" ON "Image" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "Ingredient_name_key" ON "Ingredient" USING btree ("name") WHERE "Ingredient"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Ingredient_recipeId_key" ON "Ingredient" USING btree ("recipeId") WHERE "Ingredient"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Ingredient_recipeId_idx" ON "Ingredient" USING btree ("recipeId");--> statement-breakpoint
CREATE INDEX "Ingredient_createdAt_idx" ON "Ingredient" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Ingredient_name_gin_idx" ON "Ingredient" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Ingredient_aliases_gin_idx" ON "Ingredient" USING gin ("aliases");--> statement-breakpoint
CREATE INDEX "Ingredient_name_active_idx" ON "Ingredient" USING btree ("name") WHERE "Ingredient"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "InventoryEntry_productId_locationId_key" ON "InventoryEntry" USING btree ("productId","locationId") WHERE "InventoryEntry"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "InventoryEntry_productId_idx" ON "InventoryEntry" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "InventoryEntry_locationId_idx" ON "InventoryEntry" USING btree ("locationId");--> statement-breakpoint
CREATE INDEX "InventoryEntry_createdAt_idx" ON "InventoryEntry" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "Location_shortcode_unique" ON "Location" USING btree ("shortcode") WHERE "Location"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Location_name_key" ON "Location" USING btree ("name") WHERE "Location"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Location_name_idx" ON "Location" USING btree ("name");--> statement-breakpoint
CREATE INDEX "Location_type_idx" ON "Location" USING btree ("type");--> statement-breakpoint
CREATE INDEX "Location_parentId_idx" ON "Location" USING btree ("parentId");--> statement-breakpoint
CREATE INDEX "Location_createdAt_idx" ON "Location" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Location_lastBulkInventory_idx" ON "Location" USING btree ("lastBulkInventory");--> statement-breakpoint
CREATE INDEX "Location_name_gin_idx" ON "Location" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Location_type_name_idx" ON "Location" USING btree ("type","name");--> statement-breakpoint
CREATE INDEX "Location_name_active_idx" ON "Location" USING btree ("name") WHERE "Location"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Location_type_active_idx" ON "Location" USING btree ("type") WHERE "Location"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "LocationImage_locationId_imageId_key" ON "LocationImage" USING btree ("locationId","imageId") WHERE "LocationImage"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "LocationImage_locationId_idx" ON "LocationImage" USING btree ("locationId");--> statement-breakpoint
CREATE INDEX "LocationImage_imageId_idx" ON "LocationImage" USING btree ("imageId");--> statement-breakpoint
CREATE UNIQUE INDEX "Product_shortcode_unique" ON "Product" USING btree ("shortcode") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Product_category_idx" ON "Product" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "Product_name_manufacturer_key" ON "Product" USING btree ("name","manufacturer") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Product_upc_key" ON "Product" USING btree ("upc") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Product_ndb_number_key" ON "Product" USING btree ("ndb_number") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Product_ingredientId_idx" ON "Product" USING btree ("ingredientId");--> statement-breakpoint
CREATE INDEX "Product_createdAt_idx" ON "Product" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Product_name_idx" ON "Product" USING btree ("name");--> statement-breakpoint
CREATE INDEX "Product_name_gin_idx" ON "Product" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Product_manufacturer_gin_idx" ON "Product" USING gin ("manufacturer" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Product_name_manufacturer_idx" ON "Product" USING btree ("name","manufacturer");--> statement-breakpoint
CREATE INDEX "Product_name_active_idx" ON "Product" USING btree ("name") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Product_manufacturer_active_idx" ON "Product" USING btree ("manufacturer") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ProductImage_productId_imageId_key" ON "ProductImage" USING btree ("productId","imageId") WHERE "ProductImage"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "ProductImage_imageId_idx" ON "ProductImage" USING btree ("imageId");--> statement-breakpoint
CREATE INDEX "ProductUnitMappings_productId_idx" ON "ProductUnitMappings" USING btree ("productId");--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_shortcode_unique" ON "Recipe" USING btree ("shortcode") WHERE "Recipe"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_name_key" ON "Recipe" USING btree ("name") WHERE "Recipe"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Recipe_createdAt_idx" ON "Recipe" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Recipe_SourceType_idx" ON "Recipe" USING btree ("SourceType");--> statement-breakpoint
CREATE INDEX "Recipe_name_gin_idx" ON "Recipe" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Recipe_created_at_desc_idx" ON "Recipe" USING btree ("createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "Recipe_name_active_idx" ON "Recipe" USING btree ("name") WHERE "Recipe"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "RecipeImage_recipeId_imageId_key" ON "RecipeImage" USING btree ("recipeId","imageId") WHERE "RecipeImage"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "RecipeImage_recipeId_idx" ON "RecipeImage" USING btree ("recipeId");--> statement-breakpoint
CREATE INDEX "RecipeImage_imageId_idx" ON "RecipeImage" USING btree ("imageId");--> statement-breakpoint
CREATE INDEX "RecipeSection_recipeId_idx" ON "RecipeSection" USING btree ("recipeId");--> statement-breakpoint
CREATE INDEX "RecipeSection_createdAt_idx" ON "RecipeSection" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "RecipeSectionIngredient_recipeSectionId_idx" ON "RecipeSectionIngredient" USING btree ("recipeSectionId");--> statement-breakpoint
CREATE INDEX "RecipeSectionIngredient_ingredientId_idx" ON "RecipeSectionIngredient" USING btree ("ingredientId");