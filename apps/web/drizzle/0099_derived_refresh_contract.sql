-- Apply only after compatible Workers are deployed and older invocations are drained.
-- Derived invalidation now runs through durable, paged refresh work.
DROP TRIGGER IF EXISTS "Product_supersede_suggestions_after_update" ON "Product";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Cookbook_supersede_suggestions_after_update" ON "Cookbook";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Location_supersede_suggestions_after_update" ON "Location";--> statement-breakpoint
DROP TRIGGER IF EXISTS "InventoryEntry_supersede_suggestions_after_update" ON "InventoryEntry";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Meal_supersede_suggestions_after_update" ON "Meal";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Project_supersede_suggestions_after_update" ON "Project";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Task_supersede_suggestions_after_update" ON "Task";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Vendor_supersede_suggestions_after_update" ON "Vendor";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Purchase_supersede_suggestions_after_update" ON "Purchase";--> statement-breakpoint
DROP TRIGGER IF EXISTS "FinancialAccount_supersede_suggestions_after_update" ON "FinancialAccount";--> statement-breakpoint
DROP TRIGGER IF EXISTS "FinancialTransaction_supersede_suggestions_after_update" ON "FinancialTransaction";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Expense_supersede_suggestions_after_update" ON "Expense";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Planting_supersede_suggestions_after_update" ON "Planting";--> statement-breakpoint
DROP TRIGGER IF EXISTS "GardenEntry_supersede_suggestions_after_update" ON "GardenEntry";--> statement-breakpoint
DROP TRIGGER IF EXISTS "ProductCategory_supersede_suggestions_after_update" ON "ProductCategory";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Device_supersede_suggestions_after_update" ON "Device";--> statement-breakpoint
DROP TRIGGER IF EXISTS "SpendingCategory_supersede_suggestions_after_update" ON "SpendingCategory";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Purchase_supersede_expense_vendor_suggestions_after_update" ON "Purchase";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Product_retire_identity_pairs" ON "Product";--> statement-breakpoint
DROP TRIGGER IF EXISTS "EntityAttachment_retire_identity_pairs" ON "EntityAttachment";--> statement-breakpoint
DROP TRIGGER IF EXISTS "EntitySource_retire_identity_pairs" ON "EntitySource";--> statement-breakpoint
DROP TRIGGER IF EXISTS "EntityExternalId_retire_identity_pairs" ON "EntityExternalId";--> statement-breakpoint
DROP TRIGGER IF EXISTS "ImportSourceProduct_retire_identity_pairs" ON "ImportSourceProduct";--> statement-breakpoint
DROP TRIGGER IF EXISTS "ImportSourceOrder_retire_identity_pairs" ON "ImportSourceOrder";--> statement-breakpoint
DROP TRIGGER IF EXISTS "Image_retire_identity_pairs" ON "Image";--> statement-breakpoint
DROP TRIGGER IF EXISTS "AssessmentState_retire_image_identity_pairs" ON "AssessmentState";--> statement-breakpoint
DROP TRIGGER IF EXISTS "AiAnalysis_retire_image_identity_pairs" ON "AiAnalysis";--> statement-breakpoint
DROP FUNCTION IF EXISTS "Cookbook_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "Device_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "Expense_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "FinancialAccount_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "FinancialTransaction_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "GardenEntry_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "InventoryEntry_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "Location_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "Meal_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "Planting_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "ProductCategory_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "Product_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "Project_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "Purchase_supersede_expense_vendor_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "Purchase_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "SpendingCategory_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "Task_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "Vendor_supersede_suggestions_after_update"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "retire_product_pair_evidence"();--> statement-breakpoint

--> statement-breakpoint
DROP TRIGGER IF EXISTS "EntityExternalId_retire_statement_suggestions" ON "EntityExternalId";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "StatementRow_retire_statement_suggestions" ON "StatementRow";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "retire_statement_suggestions"();
