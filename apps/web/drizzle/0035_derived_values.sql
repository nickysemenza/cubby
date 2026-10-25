CREATE SEQUENCE "public"."DerivedTicket" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "DerivedDirty" (
	"target" text NOT NULL,
	"ref" uuid NOT NULL,
	"ticket" bigint DEFAULT nextval('"DerivedTicket"') NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"dirtiedAt" timestamp DEFAULT now() NOT NULL,
	"readyAt" timestamp DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastError" text,
	CONSTRAINT "DerivedDirty_target_ref_pk" PRIMARY KEY("target","ref")
);
--> statement-breakpoint
CREATE TABLE "DerivedValue" (
	"entityId" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"sortNumber" double precision,
	"sortDate" timestamp,
	"sortText" text,
	"decidedBy" jsonb,
	"inputHash" text,
	"computedAt" timestamp NOT NULL,
	CONSTRAINT "DerivedValue_entityId_key_pk" PRIMARY KEY("entityId","key")
);
--> statement-breakpoint
ALTER TABLE "DerivedValue" ADD CONSTRAINT "DerivedValue_entity_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "DerivedDirty_ready_idx" ON "DerivedDirty" USING btree ("priority","readyAt");--> statement-breakpoint
CREATE INDEX "DerivedValue_kind_key_number_idx" ON "DerivedValue" USING btree ("kind","key","sortNumber");--> statement-breakpoint
CREATE INDEX "DerivedValue_kind_key_date_idx" ON "DerivedValue" USING btree ("kind","key","sortDate");--> statement-breakpoint
CREATE INDEX "DerivedValue_kind_key_text_idx" ON "DerivedValue" USING btree ("kind","key","sortText");--> statement-breakpoint
-- derived:begin
CREATE OR REPLACE FUNCTION derived_mark(p_target text, p_refs uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "DerivedDirty" (target, ref, priority)
    SELECT DISTINCT p_target, r, 0 FROM unnest(p_refs) AS r WHERE r IS NOT NULL
  ON CONFLICT (target, ref) DO UPDATE SET
    ticket = nextval('"DerivedTicket"'),
    priority = LEAST("DerivedDirty".priority, EXCLUDED.priority),
    "readyAt" = now(),
    attempts = 0,
    "lastError" = NULL;
  IF current_setting('cubby.derived_capture', true) IS DISTINCT FROM txid_current()::text THEN
    INSERT INTO "JobInvalidationCapture" (key, "capturedAt")
      VALUES ('derived:drain', now() AT TIME ZONE 'UTC');
    PERFORM set_config('cubby.derived_capture', txid_current()::text, true);
  END IF;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entitylink() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt') THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid, NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt') THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid, NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt') THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid, NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt') THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid, NEW."toEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."fromEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt') THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid, NEW."fromEntityId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."toEntityId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid]); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt') THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid, NEW."toEntityId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "EntityLink_derived_mark" ON "EntityLink";--> statement-breakpoint
CREATE TRIGGER "EntityLink_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "EntityLink"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_entitylink();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_expense() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid, NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid, NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid, NEW."productId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Expense_derived_mark" ON "Expense";--> statement-breakpoint
CREATE TRIGGER "Expense_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_expense();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_inventoryentry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid, NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."placement", OLD."locationId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."placement", NEW."locationId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid, NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."productId", OLD."amountValue", OLD."amountUnit", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."productId", NEW."amountValue", NEW."amountUnit", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation', ARRAY[OLD."id"::uuid, NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "InventoryEntry_derived_mark" ON "InventoryEntry";--> statement-breakpoint
CREATE TRIGGER "InventoryEntry_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "InventoryEntry"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_inventoryentry();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid, NEW."productId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid, NEW."productId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Location_derived_mark" ON "Location";--> statement-breakpoint
CREATE TRIGGER "Location_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Location"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_location();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_product() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid, NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid, NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid, NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@productId', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@productId', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@productId', ARRAY[OLD."id"::uuid, NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "Product_derived_mark" ON "Product";--> statement-breakpoint
CREATE TRIGGER "Product_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_product();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_productcategory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@categoryId', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@categoryId', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt') THEN
    PERFORM derived_mark('product.price@categoryId', ARRAY[OLD."id"::uuid, NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@categoryId', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@categoryId', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt') THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity@categoryId', ARRAY[OLD."id"::uuid, NEW."id"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@categoryId', ARRAY[NEW."id"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@categoryId', ARRAY[OLD."id"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt') THEN
    PERFORM derived_mark('product.quantityVariance@categoryId', ARRAY[OLD."id"::uuid, NEW."id"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "ProductCategory_derived_mark" ON "ProductCategory";--> statement-breakpoint
CREATE TRIGGER "ProductCategory_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "ProductCategory"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_productcategory();--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_productunitmapping() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@productId', ARRAY[NEW."productId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@productId', ARRAY[OLD."productId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt') THEN
    PERFORM derived_mark('inventory.valuation@productId', ARRAY[OLD."productId"::uuid, NEW."productId"::uuid]);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "ProductUnitMapping_derived_mark" ON "ProductUnitMapping";--> statement-breakpoint
CREATE TRIGGER "ProductUnitMapping_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "ProductUnitMapping"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_productunitmapping();--> statement-breakpoint
INSERT INTO "Job" (key, kind, input, state) VALUES ('derived:drain', 'derived.drain', '{}'::jsonb, 'queued'), ('derived:reconcile', 'derived.reconcile', '{}'::jsonb, 'completed') ON CONFLICT (key) DO NOTHING;--> statement-breakpoint
INSERT INTO "JobInvalidation" (key, "restartsPass") VALUES ('derived:drain', false) ON CONFLICT (key) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'product.price', t.id, 1 FROM "Product" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'product.ledgerExpectedQuantity', t.id, 1 FROM "Product" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'product.quantityVariance', t.id, 1 FROM "Product" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "DerivedDirty" (target, ref, priority) SELECT 'inventory.valuation', t.id, 1 FROM "InventoryEntry" t ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
-- derived:end
