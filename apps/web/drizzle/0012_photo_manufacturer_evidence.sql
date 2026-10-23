-- Evidence is independent of whether a proposal creates or selects a Product.
LOCK TABLE "PhotoGroupProposal" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "PhotoGroupProposal" ADD COLUMN "sourceManufacturer" text;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "PhotoGroupProposal" WHERE "productCreate" ? 'sourceManufacturer'
    AND jsonb_typeof("productCreate"->'sourceManufacturer') NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'Photo manufacturer evidence is not text; reconcile without discarding its original value';
  END IF;
END $$;
UPDATE "PhotoGroupProposal" SET "sourceManufacturer"="productCreate"->>'sourceManufacturer'
WHERE "productCreate" ? 'sourceManufacturer';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "PhotoGroupProposal" WHERE "productCreate" ? 'sourceManufacturer'
    AND "sourceManufacturer" IS DISTINCT FROM "productCreate"->>'sourceManufacturer') THEN
    RAISE EXCEPTION 'Photo manufacturer evidence copy was not preserved';
  END IF;
END $$;
UPDATE "PhotoGroupProposal" SET "productCreate"="productCreate"-'sourceManufacturer'
WHERE "productCreate" ? 'sourceManufacturer';
