CREATE TABLE "ImportSourceProduct" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sourceOrderId" uuid NOT NULL,
	"lineIndex" integer NOT NULL,
	"productId" uuid NOT NULL,
	CONSTRAINT "ImportSourceProduct_lineIndex_check" CHECK ("ImportSourceProduct"."lineIndex" >= 0)
);
--> statement-breakpoint
ALTER TABLE "OrderMail" ALTER COLUMN "receivedAt" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ImportSourceProduct" ADD CONSTRAINT "ImportSourceProduct_sourceOrderId_ImportSourceOrder_id_fk" FOREIGN KEY ("sourceOrderId") REFERENCES "public"."ImportSourceOrder"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportSourceProduct" ADD CONSTRAINT "ImportSourceProduct_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ImportSourceProduct_sourceOrder_line_key" ON "ImportSourceProduct" USING btree ("sourceOrderId","lineIndex");--> statement-breakpoint
CREATE INDEX "ImportSourceProduct_product_idx" ON "ImportSourceProduct" USING btree ("productId");
--> statement-breakpoint
-- Historical identities include soft-deleted Products and Purchases. Validate
-- every binding before removing its JSON representation; missing or conflicting
-- references require repair rather than silent loss of original order evidence.
DO $$
DECLARE
  source_record record;
  binding jsonb;
  binding_index numeric;
  binding_product uuid;
BEGIN
  FOR source_record IN
    SELECT id, "originalOrder" FROM "ImportSourceOrder"
    WHERE "originalOrder" ? 'productLines'
  LOOP
    IF jsonb_typeof(source_record."originalOrder"->'productLines') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid original Product binding array on source %', source_record.id;
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(source_record."originalOrder"->'productLines') item
      GROUP BY item->>'lineIndex' HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'Duplicate original Product binding on source %', source_record.id;
    END IF;
    FOR binding IN SELECT value FROM jsonb_array_elements(source_record."originalOrder"->'productLines')
    LOOP
      IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
        OR jsonb_typeof(binding->'lineIndex') IS DISTINCT FROM 'number'
        OR (binding->>'lineIndex') !~ '^(0|[1-9][0-9]*)$'
        OR jsonb_typeof(binding->'productId') IS DISTINCT FROM 'string'
        OR (binding->>'productId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Invalid original Product binding on source %', source_record.id;
      END IF;
      binding_index := (binding->>'lineIndex')::numeric;
      IF binding_index > 2147483647 THEN
        RAISE EXCEPTION 'Invalid original Product line index on source %', source_record.id;
      END IF;
      IF source_record."originalOrder" #> ARRAY['extraction','candidate','lines',binding_index::integer::text] IS NULL THEN
        RAISE EXCEPTION 'Original Product binding has no ordered line on source %', source_record.id;
      END IF;
      binding_product := (binding->>'productId')::uuid;
      IF NOT EXISTS (SELECT 1 FROM "Product" WHERE id = binding_product) THEN
        RAISE EXCEPTION 'Original Product binding references a missing Product on source %', source_record.id;
      END IF;
      IF EXISTS (SELECT 1 FROM "ImportSourceProduct" WHERE "sourceOrderId" = source_record.id
        AND "lineIndex" = binding_index::integer AND "productId" <> binding_product) THEN
        RAISE EXCEPTION 'Conflicting original Product binding on source %', source_record.id;
      END IF;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
INSERT INTO "ImportSourceProduct" ("sourceOrderId", "lineIndex", "productId")
SELECT source.id, (binding.value->>'lineIndex')::integer, (binding.value->>'productId')::uuid
FROM "ImportSourceOrder" source
CROSS JOIN LATERAL jsonb_array_elements(source."originalOrder"->'productLines') binding
WHERE source."originalOrder" ? 'productLines'
ON CONFLICT ("sourceOrderId", "lineIndex") DO NOTHING;
--> statement-breakpoint
UPDATE "ImportSourceOrder" SET "originalOrder" = "originalOrder" - 'productLines'
WHERE "originalOrder" ? 'productLines';
