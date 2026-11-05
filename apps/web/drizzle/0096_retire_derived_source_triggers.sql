-- cubby:transaction-per-statement
-- HOLD until the no-op marker and reader/writer-removal Worker are deployed and verified.
-- Each table commits independently and can replay after a partial deployment.
SET lock_timeout = '2s';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'derived_mark'
      AND (p.prosrc LIKE '%WorkItem%' OR p.prosrc LIKE '%JobInvalidationCapture%')
  ) THEN
    RAISE EXCEPTION 'Deploy and verify no-op derived_mark before retiring source triggers';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."AiAnalysis"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "AiAnalysis_derived_mark" ON public."AiAnalysis"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_aianalysis"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Cookbook"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Cookbook_derived_mark" ON public."Cookbook"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_cookbook"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."DataException"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "DataException_derived_mark" ON public."DataException"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_dataexception"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."DerivedValue"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "DerivedValue_derived_mark" ON public."DerivedValue"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_derivedvalue"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Device"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Device_derived_mark" ON public."Device"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_device"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Email"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Email_derived_mark" ON public."Email"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_email"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."EmailCandidateObservation"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "EmailCandidateObservation_derived_mark" ON public."EmailCandidateObservation"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_emailcandidateobservation"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."EmailClassificationObservation"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "EmailClassificationObservation_derived_mark" ON public."EmailClassificationObservation"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_emailclassificationobservation"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."EmailPurchaseDecision"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "EmailPurchaseDecision_derived_mark" ON public."EmailPurchaseDecision"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_emailpurchasedecision"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."EmailReview"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "EmailReview_derived_mark" ON public."EmailReview"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_emailreview"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Entity"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Entity_derived_mark" ON public."Entity"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_entity"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."EntityAttachment"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "EntityAttachment_derived_mark" ON public."EntityAttachment"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_entityattachment"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."EntityExternalId"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "EntityExternalId_derived_mark" ON public."EntityExternalId"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_entityexternalid"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."EntityLink"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "EntityLink_derived_mark" ON public."EntityLink"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_entitylink"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Expense"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Expense_derived_mark" ON public."Expense"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_expense"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ExpenseAttribution"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ExpenseAttribution_derived_mark" ON public."ExpenseAttribution"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_expenseattribution"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ExternalSource"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ExternalSource_derived_mark" ON public."ExternalSource"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_externalsource"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."FinancialAccount"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "FinancialAccount_derived_mark" ON public."FinancialAccount"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_financialaccount"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."FinancialTransaction"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "FinancialTransaction_derived_mark" ON public."FinancialTransaction"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_financialtransaction"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."FinancialTransactionAllocation"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "FinancialTransactionAllocation_derived_mark" ON public."FinancialTransactionAllocation"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_financialtransactionallocation"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."GardenEntry"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "GardenEntry_derived_mark" ON public."GardenEntry"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_gardenentry"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Image"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Image_derived_mark" ON public."Image"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_image"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ImageDerivative"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ImageDerivative_derived_mark" ON public."ImageDerivative"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_imagederivative"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ImageProcessingJob"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ImageProcessingJob_derived_mark" ON public."ImageProcessingJob"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_imageprocessingjob"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ImageSighting"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ImageSighting_derived_mark" ON public."ImageSighting"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_imagesighting"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ImportSourceClaim"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ImportSourceClaim_derived_mark" ON public."ImportSourceClaim"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_importsourceclaim"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ImportSourceOrder"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ImportSourceOrder_derived_mark" ON public."ImportSourceOrder"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_importsourceorder"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ImportSourceProduct"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ImportSourceProduct_derived_mark" ON public."ImportSourceProduct"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_importsourceproduct"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Ingredient"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Ingredient_derived_mark" ON public."Ingredient"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_ingredient"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."InventoryEntry"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "InventoryEntry_derived_mark" ON public."InventoryEntry"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_inventoryentry"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."LedgerParty"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "LedgerParty_derived_mark" ON public."LedgerParty"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_ledgerparty"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."LedgerTransfer"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "LedgerTransfer_derived_mark" ON public."LedgerTransfer"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_ledgertransfer"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Location"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Location_derived_mark" ON public."Location"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_location"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Meal"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Meal_derived_mark" ON public."Meal"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_meal"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."MealFoodEntry"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "MealFoodEntry_derived_mark" ON public."MealFoodEntry"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_mealfoodentry"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."MealRecipe"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "MealRecipe_derived_mark" ON public."MealRecipe"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_mealrecipe"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."MealRecipePortion"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "MealRecipePortion_derived_mark" ON public."MealRecipePortion"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_mealrecipeportion"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."OrderMail"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "OrderMail_derived_mark" ON public."OrderMail"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_ordermail"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."OrderMailAttachment"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "OrderMailAttachment_derived_mark" ON public."OrderMailAttachment"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_ordermailattachment"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."OrderMailEvent"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "OrderMailEvent_derived_mark" ON public."OrderMailEvent"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_ordermailevent"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."PhotoGroupProposal"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "PhotoGroupProposal_derived_mark" ON public."PhotoGroupProposal"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_photogroupproposal"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."PhotoGroupSourceEvidence"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "PhotoGroupSourceEvidence_derived_mark" ON public."PhotoGroupSourceEvidence"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_photogroupsourceevidence"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."PhotoRunImage"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "PhotoRunImage_derived_mark" ON public."PhotoRunImage"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_photorunimage"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Plant"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Plant_derived_mark" ON public."Plant"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_plant"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Planting"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Planting_derived_mark" ON public."Planting"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_planting"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Product"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Product_derived_mark" ON public."Product"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_product"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ProductCategory"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ProductCategory_derived_mark" ON public."ProductCategory"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_productcategory"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ProductConversionCoverage"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ProductConversionCoverage_derived_mark" ON public."ProductConversionCoverage"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_productconversioncoverage"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ProductUnitMapping"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ProductUnitMapping_derived_mark" ON public."ProductUnitMapping"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_productunitmapping"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Project"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Project_derived_mark" ON public."Project"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_project"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Purchase"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Purchase_derived_mark" ON public."Purchase"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_purchase"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."PurchasePaymentEvidence"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "PurchasePaymentEvidence_derived_mark" ON public."PurchasePaymentEvidence"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_purchasepaymentevidence"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Recipe"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Recipe_derived_mark" ON public."Recipe"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_recipe"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."RecipeSection"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "RecipeSection_derived_mark" ON public."RecipeSection"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_recipesection"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."RecipeSectionIngredient"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "RecipeSectionIngredient_derived_mark" ON public."RecipeSectionIngredient"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_recipesectioningredient"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Run"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Run_derived_mark" ON public."Run"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_run"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."RunOperation"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "RunOperation_derived_mark" ON public."RunOperation"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_runoperation"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Shipment"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Shipment_derived_mark" ON public."Shipment"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_shipment"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."ShipmentObservation"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "ShipmentObservation_derived_mark" ON public."ShipmentObservation"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_shipmentobservation"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."SourceTransactionRecord"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "SourceTransactionRecord_derived_mark" ON public."SourceTransactionRecord"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_sourcetransactionrecord"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."SpendingCategory"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "SpendingCategory_derived_mark" ON public."SpendingCategory"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_spendingcategory"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Suggestion"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Suggestion_derived_mark" ON public."Suggestion"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_suggestion"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Task"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Task_derived_mark" ON public."Task"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_task"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."TransactionImport"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "TransactionImport_derived_mark" ON public."TransactionImport"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_transactionimport"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."TransactionImportRecord"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "TransactionImportRecord_derived_mark" ON public."TransactionImportRecord"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_transactionimportrecord"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Vendor"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Vendor_derived_mark" ON public."Vendor"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_vendor"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."VendorAccount"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "VendorAccount_derived_mark" ON public."VendorAccount"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_vendoraccount"();
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public."Wish"') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS "Wish_derived_mark" ON public."Wish"';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."derived_mark_wish"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.derived_mark(text, uuid[]);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.derived_mark(text, uuid[], text);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND (p.proname = 'derived_mark' OR p.proname LIKE 'derived_mark\_%' ESCAPE '\')
  ) THEN
    RAISE EXCEPTION 'Unexpected derived marker remains; refresh the source-trigger census';
  END IF;
END $$;
--> statement-breakpoint
RESET lock_timeout;
