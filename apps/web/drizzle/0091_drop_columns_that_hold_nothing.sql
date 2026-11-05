-- These columns never held anything a reader could lose. Any row that says
-- otherwise aborts this transaction, and so the deployment.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM "AiUsage" WHERE "deletedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "ImageDerivative" WHERE "deletedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "ImageSighting" WHERE "deletedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'A soft delete exists on a column being dropped';
  END IF;
  IF EXISTS (SELECT 1 FROM "OrderMail"
    WHERE "classifiedChecksum" IS NOT NULL AND "classifiedChecksum" <> "rawChecksum") THEN
    RAISE EXCEPTION 'OrderMail.classifiedChecksum differs from rawChecksum';
  END IF;
END $check$;
--> statement-breakpoint
-- This trigger reads ImageSighting."deletedAt" at run time, which no catalog
-- dependency tracks, so it changes before the column goes.
CREATE OR REPLACE FUNCTION derived_mark_imagesighting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@16', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image sighting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@16', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image sighting removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@16', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image sighting changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."imageId"::uuid], 'Image sighting created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid], 'Image sighting removed'); END IF;
  ELSIF (true OR true) AND OLD."imageId" IS DISTINCT FROM NEW."imageId" THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid] || ARRAY[NEW."imageId"::uuid], 'Image sighting changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP INDEX "ImageDerivative_image_purpose_source_revision_key";--> statement-breakpoint
DROP INDEX "ImageDerivative_storage_key_key";--> statement-breakpoint
DROP INDEX "ImageSighting_image_party_asset_key";--> statement-breakpoint
CREATE UNIQUE INDEX "ImageDerivative_image_purpose_source_revision_key" ON "ImageDerivative" USING btree ("imageId","purpose","sourceContentHash","processorRevision");--> statement-breakpoint
CREATE UNIQUE INDEX "ImageDerivative_storage_key_key" ON "ImageDerivative" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "ImageSighting_image_party_asset_key" ON "ImageSighting" USING btree ("imageId","ledgerPartyId","assetKey");--> statement-breakpoint
ALTER TABLE "AiUsage" DROP COLUMN "deletedAt";--> statement-breakpoint
ALTER TABLE "ImageDerivative" DROP COLUMN "deletedAt";--> statement-breakpoint
ALTER TABLE "ImageSighting" DROP COLUMN "deletedAt";--> statement-breakpoint
ALTER TABLE "OrderMail" DROP COLUMN "classifiedChecksum";
