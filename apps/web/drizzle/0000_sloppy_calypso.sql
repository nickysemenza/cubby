CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE TYPE "public"."ImageStatus" AS ENUM('PENDING', 'UPLOADED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."RecipeSource" AS ENUM('Book', 'Website', 'Other');--> statement-breakpoint
CREATE TABLE "Image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
	"url" text NOT NULL,
	"key" text NOT NULL,
	"filename" text NOT NULL,
	"size" integer NOT NULL,
	"contentType" text NOT NULL,
	"status" "ImageStatus" DEFAULT 'PENDING' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "Image_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "Ingredient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
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
	"projectId" uuid NOT NULL,
	"productId" uuid NOT NULL,
	"amount" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"locationId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
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
	"projectId" uuid NOT NULL,
	"name" text NOT NULL,
	"manufacturer" text NOT NULL,
	"upc" text,
	"ndb_number" integer,
	"model" text,
	"expectedQuantity" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"ingredientId" uuid
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
CREATE TABLE "Project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "ProjectMember" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
	"userId" text NOT NULL,
	"joinedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Recipe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	"SourceType" "RecipeSource",
	"SourceData" text
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
CREATE TABLE "User" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"firstName" text,
	"lastName" text,
	"imageUrl" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "User_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "Image" ADD CONSTRAINT "Image_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_locationId_Location_id_fk" FOREIGN KEY ("locationId") REFERENCES "public"."Location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Location" ADD CONSTRAINT "Location_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Location" ADD CONSTRAINT "Location_parentId_Location_id_fk" FOREIGN KEY ("parentId") REFERENCES "public"."Location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LocationImage" ADD CONSTRAINT "LocationImage_locationId_Location_id_fk" FOREIGN KEY ("locationId") REFERENCES "public"."Location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LocationImage" ADD CONSTRAINT "LocationImage_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Product" ADD CONSTRAINT "Product_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Product" ADD CONSTRAINT "Product_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProductUnitMappings" ADD CONSTRAINT "ProductUnitMappings_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeImage" ADD CONSTRAINT "RecipeImage_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeImage" ADD CONSTRAINT "RecipeImage_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeSection" ADD CONSTRAINT "RecipeSection_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeSectionIngredient" ADD CONSTRAINT "RecipeSectionIngredient_recipeSectionId_RecipeSection_id_fk" FOREIGN KEY ("recipeSectionId") REFERENCES "public"."RecipeSection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RecipeSectionIngredient" ADD CONSTRAINT "RecipeSectionIngredient_ingredientId_Ingredient_id_fk" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Image_projectId_idx" ON "Image" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "Image_createdAt_idx" ON "Image" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Image_status_idx" ON "Image" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "Ingredient_projectId_name_key" ON "Ingredient" USING btree ("projectId","name");--> statement-breakpoint
CREATE UNIQUE INDEX "Ingredient_recipeId_key" ON "Ingredient" USING btree ("recipeId");--> statement-breakpoint
CREATE INDEX "Ingredient_projectId_idx" ON "Ingredient" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "Ingredient_recipeId_idx" ON "Ingredient" USING btree ("recipeId");--> statement-breakpoint
CREATE INDEX "Ingredient_createdAt_idx" ON "Ingredient" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Ingredient_name_gin_idx" ON "Ingredient" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Ingredient_aliases_gin_idx" ON "Ingredient" USING gin ("aliases");--> statement-breakpoint
CREATE UNIQUE INDEX "InventoryEntry_productId_locationId_key" ON "InventoryEntry" USING btree ("productId","locationId");--> statement-breakpoint
CREATE INDEX "InventoryEntry_projectId_idx" ON "InventoryEntry" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "InventoryEntry_productId_idx" ON "InventoryEntry" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "InventoryEntry_locationId_idx" ON "InventoryEntry" USING btree ("locationId");--> statement-breakpoint
CREATE INDEX "InventoryEntry_createdAt_idx" ON "InventoryEntry" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "Location_projectId_name_key" ON "Location" USING btree ("projectId","name");--> statement-breakpoint
CREATE INDEX "Location_projectId_idx" ON "Location" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "Location_name_idx" ON "Location" USING btree ("name");--> statement-breakpoint
CREATE INDEX "Location_type_idx" ON "Location" USING btree ("type");--> statement-breakpoint
CREATE INDEX "Location_parentId_idx" ON "Location" USING btree ("parentId");--> statement-breakpoint
CREATE INDEX "Location_createdAt_idx" ON "Location" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Location_lastBulkInventory_idx" ON "Location" USING btree ("lastBulkInventory");--> statement-breakpoint
CREATE INDEX "Location_name_gin_idx" ON "Location" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Location_type_name_idx" ON "Location" USING btree ("type","name");--> statement-breakpoint
CREATE UNIQUE INDEX "LocationImage_locationId_imageId_key" ON "LocationImage" USING btree ("locationId","imageId");--> statement-breakpoint
CREATE INDEX "LocationImage_locationId_idx" ON "LocationImage" USING btree ("locationId");--> statement-breakpoint
CREATE INDEX "LocationImage_imageId_idx" ON "LocationImage" USING btree ("imageId");--> statement-breakpoint
CREATE UNIQUE INDEX "Product_projectId_name_manufacturer_key" ON "Product" USING btree ("projectId","name","manufacturer");--> statement-breakpoint
CREATE UNIQUE INDEX "Product_upc_key" ON "Product" USING btree ("upc");--> statement-breakpoint
CREATE UNIQUE INDEX "Product_ndb_number_key" ON "Product" USING btree ("ndb_number");--> statement-breakpoint
CREATE INDEX "Product_projectId_idx" ON "Product" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "Product_ingredientId_idx" ON "Product" USING btree ("ingredientId");--> statement-breakpoint
CREATE INDEX "Product_createdAt_idx" ON "Product" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Product_name_idx" ON "Product" USING btree ("name");--> statement-breakpoint
CREATE INDEX "Product_name_gin_idx" ON "Product" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Product_manufacturer_gin_idx" ON "Product" USING gin ("manufacturer" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Product_name_manufacturer_idx" ON "Product" USING btree ("name","manufacturer");--> statement-breakpoint
CREATE UNIQUE INDEX "ProductImage_productId_imageId_key" ON "ProductImage" USING btree ("productId","imageId");--> statement-breakpoint
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "ProductImage_imageId_idx" ON "ProductImage" USING btree ("imageId");--> statement-breakpoint
CREATE INDEX "ProductUnitMappings_productId_idx" ON "ProductUnitMappings" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "Project_createdAt_idx" ON "Project" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Project_name_idx" ON "Project" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember" USING btree ("projectId","userId");--> statement-breakpoint
CREATE INDEX "ProjectMember_projectId_idx" ON "ProjectMember" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_projectId_name_key" ON "Recipe" USING btree ("projectId","name");--> statement-breakpoint
CREATE INDEX "Recipe_projectId_idx" ON "Recipe" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "Recipe_createdAt_idx" ON "Recipe" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Recipe_SourceType_idx" ON "Recipe" USING btree ("SourceType");--> statement-breakpoint
CREATE INDEX "Recipe_name_gin_idx" ON "Recipe" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "Recipe_created_at_desc_idx" ON "Recipe" USING btree ("createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "RecipeImage_recipeId_imageId_key" ON "RecipeImage" USING btree ("recipeId","imageId");--> statement-breakpoint
CREATE INDEX "RecipeImage_recipeId_idx" ON "RecipeImage" USING btree ("recipeId");--> statement-breakpoint
CREATE INDEX "RecipeImage_imageId_idx" ON "RecipeImage" USING btree ("imageId");--> statement-breakpoint
CREATE INDEX "RecipeSection_recipeId_idx" ON "RecipeSection" USING btree ("recipeId");--> statement-breakpoint
CREATE INDEX "RecipeSection_createdAt_idx" ON "RecipeSection" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "RecipeSectionIngredient_recipeSectionId_idx" ON "RecipeSectionIngredient" USING btree ("recipeSectionId");--> statement-breakpoint
CREATE INDEX "RecipeSectionIngredient_ingredientId_idx" ON "RecipeSectionIngredient" USING btree ("ingredientId");--> statement-breakpoint
CREATE INDEX "User_email_idx" ON "User" USING btree ("email");