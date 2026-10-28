CREATE INDEX "WorkItem_target_prefix_idx" ON "WorkItem" USING btree ("target" COLLATE "C");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entityexternalid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.food', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.food', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.food', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('recipe.totals@0', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('recipe.totals@0', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals@0', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('inventory.searchDocument@12', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('inventory.searchDocument@12', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."entityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid]); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entitylink() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price@5', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price@5', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost@5', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost@5', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts@5', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts@5', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@21', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@21', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@21', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@28', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@28', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@28', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@5', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@5', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@12', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@12', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@12', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@2', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@2', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@2', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@3', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@3', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@3', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@5', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@5', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@6', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@6', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@6', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@13', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@13', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@13', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@18', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@18', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@18', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('project.dataQuality@18', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('project.dataQuality@18', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('project.dataQuality@18', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@25', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@25', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('task.dataQuality@25', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@62', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@62', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('task.dataQuality@62', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchasePaymentAccount' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchasePaymentAccount' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'purchasePaymentAccount' OR NEW."kind" = 'purchasePaymentAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.dataQuality@4', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.dataQuality@4', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('wish.dataQuality@4', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('planting.dataQuality@4', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('planting.dataQuality@4', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (OLD."toEntityId", OLD."deletedAt", OLD."fromEntityId", OLD."kind") IS DISTINCT FROM (NEW."toEntityId", NEW."deletedAt", NEW."fromEntityId", NEW."kind") THEN
    PERFORM derived_mark('planting.dataQuality@4', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('plant.dataQuality@8', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('plant.dataQuality@8', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (OLD."toEntityId", OLD."deletedAt", OLD."fromEntityId", OLD."kind") IS DISTINCT FROM (NEW."toEntityId", NEW."deletedAt", NEW."fromEntityId", NEW."kind") THEN
    PERFORM derived_mark('plant.dataQuality@8', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_expense() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@6', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@6', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@6', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@6', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@6', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@6', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@20', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@20', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@20', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@27', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@27', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@27', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@4', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@4', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@4', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@11', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@11', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@11', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@7', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@7', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@7', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@23', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@23', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality@23', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@1', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@1', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@1', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@6', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@6', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@3', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@3', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@3', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@5', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@5', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@5', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@12', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@12', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@12', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."projectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."projectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."projectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."projectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."cost", OLD."future", OLD."lineKind", OLD."date", OLD."purchaseId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."cost", NEW."future", NEW."lineKind", NEW."date", NEW."purchaseId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@12', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@12', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@12', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@13', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@13', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@19', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@19', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@14', ARRAY[NEW."projectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@14', ARRAY[OLD."projectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('project.dataQuality@14', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@21', ARRAY[NEW."projectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@21', ARRAY[OLD."projectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('task.dataQuality@21', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@58', ARRAY[NEW."projectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@58', ARRAY[OLD."projectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('task.dataQuality@58', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@13', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@13', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('purchase.dataQuality@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."cost", OLD."future", OLD."purchaseId", OLD."deletedAt", OLD."name") IS DISTINCT FROM (NEW."id", NEW."cost", NEW."future", NEW."purchaseId", NEW."deletedAt", NEW."name") THEN
    PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@13', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@13', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."cost", OLD."lineKind", OLD."productId", OLD."projectId", OLD."spendingCategoryId", OLD."trade", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."purchaseId", NEW."cost", NEW."lineKind", NEW."productId", NEW."projectId", NEW."spendingCategoryId", NEW."trade", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@14', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@14', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('expense.dataQuality@14', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@31', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@31', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."cost", OLD."lineKind", OLD."productId", OLD."projectId", OLD."spendingCategoryId", OLD."trade", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."purchaseId", NEW."cost", NEW."lineKind", NEW."productId", NEW."projectId", NEW."spendingCategoryId", NEW."trade", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@31', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_expenseattribution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@34', ARRAY[NEW."expenseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@34', ARRAY[OLD."expenseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@34', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@35', ARRAY[NEW."expenseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@35', ARRAY[OLD."expenseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@35', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@18', ARRAY[NEW."expenseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@18', ARRAY[OLD."expenseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@18', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@19', ARRAY[NEW."expenseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@19', ARRAY[OLD."expenseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@19', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@19', ARRAY[NEW."expenseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@19', ARRAY[OLD."expenseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@19', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@20', ARRAY[NEW."expenseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@20', ARRAY[OLD."expenseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@20', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[NEW."expenseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."expenseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."expenseId"::uuid] || ARRAY[NEW."expenseId"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_financialaccount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@25', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@25', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@32', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@32', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@9', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@9', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@16', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@16', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@10', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@10', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@17', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@17', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."ledgerPartyId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."ledgerPartyId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@26', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@26', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@27', ARRAY[NEW."providerVendorId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@27', ARRAY[OLD."providerVendorId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."providerVendorId", OLD."identity", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."providerVendorId", NEW."identity", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@27', ARRAY[OLD."providerVendorId"::uuid] || ARRAY[NEW."providerVendorId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@29', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@29', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@12', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@12', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_financialtransaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@24', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@24', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@31', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@31', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@31', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@8', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@8', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@15', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@15', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@9', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@9', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@16', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@16', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[NEW."ledgerTransferId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."ledgerTransferId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."ledgerTransferId", OLD."deletedAt", OLD."status") IS DISTINCT FROM (NEW."ledgerTransferId", NEW."deletedAt", NEW."status") THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."ledgerTransferId"::uuid] || ARRAY[NEW."ledgerTransferId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@25', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@25', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_financialtransactionallocation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@23', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@23', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@23', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@30', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@30', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@30', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@7', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@7', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@7', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@14', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@14', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@14', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@8', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@8', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@8', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@15', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@15', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@15', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."transactionId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."transactionId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@4', ARRAY[NEW."transactionId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@4', ARRAY[OLD."transactionId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."transactionId", OLD."deletedAt", OLD."purchaseId") IS DISTINCT FROM (NEW."transactionId", NEW."deletedAt", NEW."purchaseId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@4', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."transactionId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."transactionId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_inventoryentry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."locationId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."locationId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."locationId", OLD."placement", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."locationId", NEW."placement", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."locationId"::uuid] || ARRAY[NEW."locationId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@12', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@12', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@12', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.ownership', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@2', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@2', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."ownershipMode", OLD."ownerLedgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."ownershipMode", NEW."ownerLedgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.ownership@2', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_ledgerparty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@36', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@36', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@36', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@37', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@37', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@37', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@38', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@38', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@38', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@39', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@39', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@39', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@40', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@40', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@40', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@41', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@41', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@41', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@42', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@42', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@42', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@20', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@20', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@21', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@21', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@22', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@22', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@23', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@23', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@24', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@24', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@25', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@25', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@26', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@26', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@21', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@21', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@22', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@22', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@23', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@23', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@24', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@24', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@25', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@25', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@26', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@26', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@27', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@27', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@18', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@18', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."kind", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."kind", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@8', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@8', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@39', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@39', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@39', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@40', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@40', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@40', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@9', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@9', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."kind", OLD."name", OLD."shortcode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."kind", NEW."name", NEW."shortcode", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.beneficiaryResult@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@8', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@8', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@44', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@44', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@44', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[NEW."parentId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."parentId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."parentId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."parentId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup', ARRAY[OLD."parentId"::uuid] || ARRAY[NEW."parentId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@11', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@11', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@7', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@7', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@14', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@14', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productId") THEN
    PERFORM derived_mark('inventory.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@22', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@22', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@9', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@9', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@10', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@10', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_product() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@7', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@7', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@7', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@7', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@7', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@7', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."stockTracked", OLD."categoryId") IS DISTINCT FROM (NEW."id", NEW."stockTracked", NEW."categoryId") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.food', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.food', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."fdc_id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."fdc_id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.food', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@0', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@0', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@2', ARRAY[NEW."ingredientId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@2', ARRAY[OLD."ingredientId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."name", OLD."shortcode", OLD."categoryId", OLD."fdc_id", OLD."labelNutrition", OLD."usdaUnavailable", OLD."price", OLD."deletedAt") IS DISTINCT FROM (NEW."ingredientId", NEW."name", NEW."shortcode", NEW."categoryId", NEW."fdc_id", NEW."labelNutrition", NEW."usdaUnavailable", NEW."price", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.totals@2', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[NEW."ingredientId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[OLD."ingredientId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."ingredientId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[NEW."ingredientId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[OLD."ingredientId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."ingredientId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."ingredientId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@0', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@0', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@1', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@1', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@7', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@7', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('location.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@0', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@0', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@7', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@7', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@1', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@1', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.ownership@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@9', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@9', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@10', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@10', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('inventory.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@15', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@15', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@18', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@18', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('inventory.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@21', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@21', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@11', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@11', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@15', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@15', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@19', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@19', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@22', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@22', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@26', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@26', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@30', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@30', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@11', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@11', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@12', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@12', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@7', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@7', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@13', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@13', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@18', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@18', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@22', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@22', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@26', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@26', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@29', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@29', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@33', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@33', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@37', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@37', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@37', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@44', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@44', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@44', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@50', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@50', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@50', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@55', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@55', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@55', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@59', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@59', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@59', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@63', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@63', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@63', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@66', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@66', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@66', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@70', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@70', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@70', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@74', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@74', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@74', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@14', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@14', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@20', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@20', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('purchase.dataQuality@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@34', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@34', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."categoryId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."categoryId") THEN
    PERFORM derived_mark('purchase.dataQuality@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@9', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@9', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."model", OLD."brandId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."model", NEW."brandId", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@8', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@8', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('wish.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@8', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@8', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@10', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@10', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('expense.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@15', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@15', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@22', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@22', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('expense.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@26', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@26', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@35', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@35', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality@35', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@8', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@8', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@11', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@11', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('planting.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[NEW."categoryId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[OLD."categoryId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."categoryId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."categoryId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[OLD."categoryId"::uuid] || ARRAY[NEW."categoryId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[NEW."categoryId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[OLD."categoryId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."categoryId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."categoryId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[OLD."categoryId"::uuid] || ARRAY[NEW."categoryId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('device.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@7', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@7', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('device.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@4', ARRAY[NEW."growsPlantId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@4', ARRAY[OLD."growsPlantId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."growsPlantId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."growsPlantId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('plant.dataQuality@4', ARRAY[OLD."growsPlantId"::uuid] || ARRAY[NEW."growsPlantId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@12', ARRAY[NEW."growsPlantId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@12', ARRAY[OLD."growsPlantId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."growsPlantId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."growsPlantId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('plant.dataQuality@12', ARRAY[OLD."growsPlantId"::uuid] || ARRAY[NEW."growsPlantId"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_productcategory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@8', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@8', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@8', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@8', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@8', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@8', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@15', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@15', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@10', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@10', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@28', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@28', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@8', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@8', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@10', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@10', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@22', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@22', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@35', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@35', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@35', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@9', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@9', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@27', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@27', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_purchase() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@19', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@19', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@26', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@26', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@3', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@3', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@10', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@10', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@18', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@18', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@19', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@19', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@11', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@11', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."defaultProjectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."defaultProjectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."defaultProjectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."defaultProjectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."defaultProjectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."defaultProjectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@14', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@14', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@20', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@20', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."defaultProjectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."defaultProjectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@4', ARRAY[NEW."defaultProjectId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@4', ARRAY[OLD."defaultProjectId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@4', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."vendorId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."vendorId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."vendorId"::uuid] || ARRAY[NEW."vendorId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."vendorId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."vendorId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@17', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@17', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@7', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@7', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@18', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@18', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."vendorId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."vendorId") THEN
    PERFORM derived_mark('expense.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@34', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@34', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderId", OLD."vendorId", OLD."vendorAccountId", OLD."statedTotal", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."orderId", NEW."vendorId", NEW."vendorAccountId", NEW."statedTotal", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('email.relationshipFacts@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorAccountId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorAccountId", NEW."deletedAt") THEN
    PERFORM derived_mark('email.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@11', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@11', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@4', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@4', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('shipment.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_vendoraccount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@22', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@22', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@29', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@29', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@13', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@13', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@7', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@7', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@14', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@14', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@33', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@33', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@6', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@6', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('email.relationshipFacts@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@5', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@5', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('email.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@12', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@12', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Retain existing work; admit only the new display fact families.
INSERT INTO "WorkItem" (drain, target, ref, priority)
SELECT 'derived:drain', target, p.id, 2
FROM "Product" p CROSS JOIN (VALUES ('product.readFacts'), ('product.food')) AS facts(target)
WHERE p."deletedAt" IS NULL
ON CONFLICT (target, ref) DO NOTHING;
--> statement-breakpoint
INSERT INTO "JobInvalidationCapture" (key, "capturedAt") VALUES ('derived:drain', now() AT TIME ZONE 'UTC');
