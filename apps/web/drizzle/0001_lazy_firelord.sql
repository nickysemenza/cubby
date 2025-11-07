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
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
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
	"active_organization_id" text,
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
ALTER TABLE "Image" DROP CONSTRAINT "Image_projectId_Project_id_fk";
--> statement-breakpoint
ALTER TABLE "Ingredient" DROP CONSTRAINT "Ingredient_projectId_Project_id_fk";
--> statement-breakpoint
ALTER TABLE "InventoryEntry" DROP CONSTRAINT "InventoryEntry_projectId_Project_id_fk";
--> statement-breakpoint
ALTER TABLE "Location" DROP CONSTRAINT "Location_projectId_Project_id_fk";
--> statement-breakpoint
ALTER TABLE "Location" DROP CONSTRAINT "Location_parentId_Location_id_fk";
--> statement-breakpoint
ALTER TABLE "Product" DROP CONSTRAINT "Product_projectId_Project_id_fk";
--> statement-breakpoint
ALTER TABLE "Recipe" DROP CONSTRAINT "Recipe_projectId_Project_id_fk";
--> statement-breakpoint
ALTER TABLE "Project" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ProjectMember" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "User" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "Project" CASCADE;--> statement-breakpoint
DROP TABLE "ProjectMember" CASCADE;--> statement-breakpoint
DROP TABLE "User" CASCADE;--> statement-breakpoint
DROP INDEX "Image_projectId_idx";--> statement-breakpoint
DROP INDEX "Ingredient_projectId_name_key";--> statement-breakpoint
DROP INDEX "Ingredient_projectId_idx";--> statement-breakpoint
DROP INDEX "InventoryEntry_projectId_idx";--> statement-breakpoint
DROP INDEX "Location_projectId_name_key";--> statement-breakpoint
DROP INDEX "Location_projectId_idx";--> statement-breakpoint
DROP INDEX "Product_projectId_name_manufacturer_key";--> statement-breakpoint
DROP INDEX "Product_projectId_idx";--> statement-breakpoint
DROP INDEX "Recipe_projectId_name_key";--> statement-breakpoint
DROP INDEX "Recipe_projectId_idx";--> statement-breakpoint
ALTER TABLE "Image" ADD COLUMN "organizationId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "Ingredient" ADD COLUMN "organizationId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD COLUMN "organizationId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "Location" ADD COLUMN "organizationId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "Product" ADD COLUMN "organizationId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN "organizationId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Image" ADD CONSTRAINT "Image_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Location" ADD CONSTRAINT "Location_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Image_organizationId_idx" ON "Image" USING btree ("organizationId");--> statement-breakpoint
CREATE UNIQUE INDEX "Ingredient_organizationId_name_key" ON "Ingredient" USING btree ("organizationId","name");--> statement-breakpoint
CREATE INDEX "Ingredient_organizationId_idx" ON "Ingredient" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "InventoryEntry_organizationId_idx" ON "InventoryEntry" USING btree ("organizationId");--> statement-breakpoint
CREATE UNIQUE INDEX "Location_organizationId_name_key" ON "Location" USING btree ("organizationId","name");--> statement-breakpoint
CREATE INDEX "Location_organizationId_idx" ON "Location" USING btree ("organizationId");--> statement-breakpoint
CREATE UNIQUE INDEX "Product_organizationId_name_manufacturer_key" ON "Product" USING btree ("organizationId","name","manufacturer");--> statement-breakpoint
CREATE INDEX "Product_organizationId_idx" ON "Product" USING btree ("organizationId");--> statement-breakpoint
CREATE UNIQUE INDEX "Recipe_organizationId_name_key" ON "Recipe" USING btree ("organizationId","name");--> statement-breakpoint
CREATE INDEX "Recipe_organizationId_idx" ON "Recipe" USING btree ("organizationId");--> statement-breakpoint
ALTER TABLE "Image" DROP COLUMN "projectId";--> statement-breakpoint
ALTER TABLE "Ingredient" DROP COLUMN "projectId";--> statement-breakpoint
ALTER TABLE "InventoryEntry" DROP COLUMN "projectId";--> statement-breakpoint
ALTER TABLE "Location" DROP COLUMN "projectId";--> statement-breakpoint
ALTER TABLE "Product" DROP COLUMN "projectId";--> statement-breakpoint
ALTER TABLE "Recipe" DROP COLUMN "projectId";