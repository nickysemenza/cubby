ALTER TABLE "ExternalSource" ADD COLUMN "issuer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Carry the previous resolution forward: a Vendor's sole owned source, or its
-- sole owned full-host registration when it also owns legacy or export slugs.
-- A Vendor with neither registers its host issuer on its next import.
UPDATE "ExternalSource" source SET "issuer" = true
FROM (
  SELECT "vendorId",
    CASE
      WHEN count(*) FILTER (WHERE slug LIKE 'host-%') = 1
        THEN (array_agg(slug) FILTER (WHERE slug LIKE 'host-%'))[1]
      WHEN count(*) = 1 THEN (array_agg(slug))[1]
    END AS slug
  FROM "ExternalSource"
  WHERE "vendorId" IS NOT NULL
  GROUP BY "vendorId"
) chosen
WHERE source.slug = chosen.slug;--> statement-breakpoint
CREATE UNIQUE INDEX "ExternalSource_vendor_issuer_key" ON "ExternalSource" USING btree ("vendorId") WHERE "ExternalSource"."issuer";
