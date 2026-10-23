-- Both executable proposal locations use the same FK, like the category edit.
LOCK TABLE "PhotoGroupProposal", "Vendor" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "PhotoGroupProposal" ADD COLUMN "productCreateBrandId" uuid;--> statement-breakpoint
ALTER TABLE "PhotoGroupProposal" ADD CONSTRAINT "PhotoGroupProposal_productCreateBrandId_Vendor_id_fk" FOREIGN KEY ("productCreateBrandId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "PhotoGroupProposal" p WHERE
    coalesce(p."productCreate"->>'brandId', p.review->'productChanges'->>'brandId') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Vendor" v WHERE v.shortcode=coalesce(p."productCreate"->>'brandId', p.review->'productChanges'->>'brandId') AND v."deletedAt" IS NULL)) THEN
    RAISE EXCEPTION 'Photo Brand proposal names a missing Vendor';
  END IF;
END $$;
UPDATE "PhotoGroupProposal" p SET "productCreateBrandId"=v.id
FROM "Vendor" v WHERE v.shortcode=coalesce(p."productCreate"->>'brandId', p.review->'productChanges'->>'brandId');
UPDATE "PhotoGroupProposal" SET "productCreate"="productCreate"-'brandId' WHERE "productCreate" ? 'brandId';
-- A null placeholder records an explicit clear; absence remains no edit.
UPDATE "PhotoGroupProposal" SET review=jsonb_set(review, '{productChanges,brandId}', 'null'::jsonb)
WHERE review->'productChanges' ? 'brandId';
