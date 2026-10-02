ALTER TABLE "Cookbook" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Device" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Expense" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "FinancialAccount" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "FinancialTransaction" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "GardenEntry" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Image" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Ingredient" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "LedgerParty" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "LedgerTransfer" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Location" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Meal" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Plant" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Planting" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Product" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "ProductCategory" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Project" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Purchase" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "SpendingCategory" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Task" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Vendor" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "VendorAccount" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "Wish" ADD COLUMN "emoji" text;
--> statement-breakpoint
UPDATE "Project" SET "emoji" = "icon" WHERE "emoji" IS NULL AND "icon" IS NOT NULL;
