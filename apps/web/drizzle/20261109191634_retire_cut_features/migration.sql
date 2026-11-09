-- #3899 removes AI connection discovery, the product-identity and transfer-pair
-- evaluators, tag propagation and Wish; the owner also retired the archived review
-- ledgers that 0080 copied into "Suggestion" under an aborting preservation check.
-- Undecided machinery output goes. A row carrying a decision, an application, money
-- or AI cost evidence stays: decided and applied Suggestions, Run rows, AiUsage
-- (wish attribution is cleared, cost kept) and every archive money preimage.
-- Apply after the Worker without these readers and writers is deployed.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DELETE FROM "Suggestion"
WHERE jsonb_array_length("decisions") = 0
  AND "status" <> 'applied'
  AND (
    "family" IN ('product_pair', 'transfer_pair')
    OR ("family" = 'recommendation'
        AND ("subject"->>'scope' = 'product.tag-propagation'
             OR ("subject"->>'scope' LIKE 'connection.%'
                 AND "subject"->>'scope' <> 'connection.email-purchase')))
    OR "entity" = 'wish'
  );
--> statement-breakpoint
DELETE FROM "AiEvaluationRequest" r
USING "AiEvaluation" e
WHERE r."evaluationId" = e.id
  AND e."target"->>'kind' IN ('connection', 'product', 'product_pair');
--> statement-breakpoint
DELETE FROM "AiEvaluation" e
WHERE e."target"->>'kind' IN ('connection', 'product', 'product_pair');
--> statement-breakpoint
-- Email refresh execution was removed; its unstarted work can never run.
UPDATE "AiEvaluation" e
SET "state" = 'obsolete', "leaseToken" = NULL, "leaseUntil" = NULL, "updatedAt" = now()
FROM "Run" r
WHERE e."runId" = r.id
  AND r.purpose = 'ai_refresh'
  AND e."target"->>'kind' = 'email'
  AND e."state" IN ('queued', 'blocked');
--> statement-breakpoint
-- Failed attempts of the removed scheduled ai_refresh Runs. The Runs stay: AiUsage
-- references them as cost evidence.
DELETE FROM "Job" j
USING "Run" r
WHERE j."runId" = r.id
  AND j.kind = 'run.execute'
  AND j.state = 'failed'
  AND r.purpose = 'ai_refresh'
  AND r.trigger = 'scheduled'
  AND r.cause IS DISTINCT FROM 'member_request'
  AND r.status = 'failed';
--> statement-breakpoint
-- The retired connection-discovery cursor.
DELETE FROM "AppSettings" WHERE id = '0553199e-d21b-4325-8c52-cfb28fc26a2f';
--> statement-breakpoint
UPDATE "AiUsage" SET "entityId" = NULL, "entityKind" = NULL WHERE "entityKind" = 'wish';
--> statement-breakpoint
DELETE FROM "EntityLink" WHERE "fromKind" = 'wish' OR "toKind" = 'wish';
--> statement-breakpoint
DELETE FROM "AuditLog" WHERE "entityId" IN (SELECT id FROM "Entity" WHERE kind = 'wish');
--> statement-breakpoint
DELETE FROM "SearchDocument" WHERE "entityId" IN (SELECT id FROM "Entity" WHERE kind = 'wish');
--> statement-breakpoint
DELETE FROM "EntityEmbedding" WHERE "entityId" IN (SELECT id FROM "Entity" WHERE kind = 'wish');
--> statement-breakpoint
DELETE FROM "Wish";
--> statement-breakpoint
DELETE FROM "Entity" WHERE kind = 'wish';
--> statement-breakpoint
DROP TABLE IF EXISTS archive."Feedback";
--> statement-breakpoint
DROP TABLE IF EXISTS archive."AssessmentState";
--> statement-breakpoint
DROP TABLE IF EXISTS archive."Assessment";
--> statement-breakpoint
DROP TABLE "Wish";--> statement-breakpoint
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_kind_check", ADD CONSTRAINT "Entity_kind_check" CHECK ("kind" IN ('product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory', 'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor', 'purchase', 'financialAccount', 'financialTransaction', 'expense', 'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory', 'run', 'device', 'plant', 'spendingCategory', 'email', 'imageJob', 'sourceTransactionRecord', 'transactionImport', 'shipment', 'sourceOccurrence'));--> statement-breakpoint
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_shortcode_prefix_check", ADD CONSTRAINT "Entity_shortcode_prefix_check" CHECK ("shortcode" IS NULL OR CASE "kind" WHEN 'product' THEN "shortcode" LIKE 'PRD-%' WHEN 'recipe' THEN "shortcode" LIKE 'RCP-%' WHEN 'ingredient' THEN "shortcode" LIKE 'ING-%' WHEN 'cookbook' THEN "shortcode" LIKE 'CKB-%' WHEN 'location' THEN "shortcode" LIKE 'LOC-%' WHEN 'inventory' THEN "shortcode" LIKE 'INV-%' WHEN 'meal' THEN "shortcode" LIKE 'MEL-%' WHEN 'ledgerParty' THEN "shortcode" LIKE 'LPY-%' WHEN 'ledgerTransfer' THEN "shortcode" LIKE 'LTR-%' WHEN 'project' THEN "shortcode" LIKE 'PRJ-%' WHEN 'task' THEN "shortcode" LIKE 'TSK-%' WHEN 'vendor' THEN "shortcode" LIKE 'VEN-%' WHEN 'purchase' THEN "shortcode" LIKE 'PUR-%' WHEN 'financialAccount' THEN "shortcode" LIKE 'FAC-%' WHEN 'financialTransaction' THEN "shortcode" LIKE 'FTX-%' WHEN 'expense' THEN "shortcode" LIKE 'EXP-%' WHEN 'image' THEN "shortcode" LIKE 'IMG-%' WHEN 'planting' THEN "shortcode" LIKE 'PLT-%' WHEN 'gardenEntry' THEN "shortcode" LIKE 'GDE-%' WHEN 'vendorAccount' THEN "shortcode" LIKE 'VACCT-%' WHEN 'productCategory' THEN "shortcode" LIKE 'CAT-%' WHEN 'run' THEN "shortcode" LIKE 'RUN-%' WHEN 'device' THEN "shortcode" LIKE 'DEV-%' WHEN 'plant' THEN "shortcode" LIKE 'PLANT-%' WHEN 'spendingCategory' THEN "shortcode" LIKE 'SPC-%' WHEN 'email' THEN "shortcode" LIKE 'EML-%' WHEN 'imageJob' THEN "shortcode" LIKE 'IPR-%' WHEN 'sourceTransactionRecord' THEN "shortcode" LIKE 'STR-%' WHEN 'transactionImport' THEN "shortcode" LIKE 'TIM-%' WHEN 'shipment' THEN "shortcode" LIKE 'SHIP-%' WHEN 'sourceOccurrence' THEN "shortcode" LIKE 'SOC-%' ELSE false END);--> statement-breakpoint
ALTER TABLE "EntityLink" DROP CONSTRAINT "EntityLink_kind_check", ADD CONSTRAINT "EntityLink_kind_check" CHECK (("kind", "fromKind", "toKind") IN (('purchaseProduct', 'purchase', 'product'), ('purchasePaymentAccount', 'purchase', 'financialAccount'), ('projectTool', 'project', 'product'), ('gardenEntryPlanting', 'gardenEntry', 'planting'), ('productComponent', 'product', 'product'), ('taskDependency', 'task', 'task'), ('projectDependency', 'project', 'project')));