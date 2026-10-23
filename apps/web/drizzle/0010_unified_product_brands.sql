-- Approved breaking cutover: block old readers/writers until this transaction commits.
-- Every retired source and copy destination is locked before its first read.
LOCK TABLE "Product", "Vendor", "Entity", "AuditLog", "ImportPreparedLine", "PhotoGroupProposal", "DataException", "AssessmentState" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- ECMAScript String.trim whitespace, shared with external Brand ingress.
CREATE FUNCTION pg_temp.brand_trim(value text) RETURNS text LANGUAGE SQL IMMUTABLE STRICT AS $trim$
  SELECT btrim(value, chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279))
$trim$;
--> statement-breakpoint
DROP INDEX "Product_name_manufacturer_key";--> statement-breakpoint
DROP INDEX "Product_manufacturer_gin_idx";--> statement-breakpoint
DROP INDEX "Product_name_manufacturer_idx";--> statement-breakpoint
DROP INDEX "Product_manufacturer_active_idx";--> statement-breakpoint
DROP INDEX "Vendor_name_key";--> statement-breakpoint
ALTER TABLE "Product" ADD COLUMN "brandId" uuid;--> statement-breakpoint
ALTER TABLE "Vendor" ADD COLUMN "systemKey" text;--> statement-breakpoint
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandId_Vendor_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- These retired executable suggestions need explicit member review if they
-- appear between rehearsal and deploy; never reinterpret their text as an FK.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "AssessmentState" WHERE field='manufacturer') OR
     EXISTS (SELECT 1 FROM "PhotoGroupProposal" WHERE review->'productChanges' ? 'manufacturer') THEN
    RAISE EXCEPTION 'Retired manufacturer proposal needs explicit reconciliation before Brand cutover';
  END IF;
  IF EXISTS (SELECT 1 FROM "DataException" old JOIN "DataException" current
    ON old."entityId"=current."entityId" AND old."check"='product_manufacturer' AND current."check"='product_brand') THEN
    RAISE EXCEPTION 'Both old and new Brand exceptions exist; reconcile without discarding member knowledge';
  END IF;
END $$;

-- The system identity is independent of its display name and commodity status.
DO $$ DECLARE ordinal bigint := 0; code text; BEGIN
  LOOP
    IF ordinal >= 28629151 THEN RAISE EXCEPTION 'Vendor shortcode namespace exhausted'; END IF;
    code := 'VEN-' ||
      substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 923521) % 31)::int + 1, 1) ||
      substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 29791) % 31)::int + 1, 1) ||
      substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 961) % 31)::int + 1, 1) ||
      substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 31) % 31)::int + 1, 1) ||
      substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', (ordinal % 31)::int + 1, 1);
    ordinal := ordinal + 1;
    IF NOT EXISTS (SELECT 1 FROM "Entity" WHERE shortcode=code) THEN
      INSERT INTO "Entity" (id, kind, shortcode) VALUES (md5('cubby:vendor:generic-unbranded')::uuid, 'vendor', code);
      EXIT;
    END IF;
  END LOOP;
END $$;
INSERT INTO "Vendor" (id, shortcode, name, "systemKey")
SELECT id, shortcode, 'Generic / Unbranded', 'generic-unbranded' FROM "Entity" WHERE id=md5('cubby:vendor:generic-unbranded')::uuid;

-- Match only the predecessor Vendor roster. Never let newly-created brands
-- change a later source's match, and never merge Products as a side effect.
CREATE TEMP TABLE brand_cutover_map ON COMMIT DROP AS
WITH sources AS (
  SELECT DISTINCT manufacturer AS source FROM "Product"
  UNION SELECT DISTINCT "productCreate"->>'manufacturer' FROM "PhotoGroupProposal" WHERE "productCreate" ? 'manufacturer'
), matched AS (
  SELECT source, pg_temp.brand_trim(source) AS name, lower(pg_temp.brand_trim(source)) AS normalized,
    ARRAY(SELECT v.id FROM "Vendor" v WHERE v."deletedAt" IS NULL AND v."systemKey" IS NULL
      AND (lower(pg_temp.brand_trim(v.name))=lower(pg_temp.brand_trim(source)) OR EXISTS
        (SELECT 1 FROM unnest(v.aliases) alias WHERE lower(pg_temp.brand_trim(alias))=lower(pg_temp.brand_trim(source)))) ORDER BY v.id) AS matches
  FROM sources WHERE source IS NOT NULL
)
SELECT source, name,
  CASE WHEN normalized IN ('', '(unspecified)') THEN NULL::uuid
    WHEN normalized IN ('generic', 'unbranded', 'generic / unbranded') THEN md5('cubby:vendor:generic-unbranded')::uuid
    WHEN cardinality(matches)=1 THEN matches[1]
    ELSE (substr(md5('cubby:brand-cutover:' || source),1,8)||'-'||substr(md5('cubby:brand-cutover:' || source),9,4)||'-4'||substr(md5('cubby:brand-cutover:' || source),14,3)||'-8'||substr(md5('cubby:brand-cutover:' || source),18,3)||'-'||substr(md5('cubby:brand-cutover:' || source),21,12))::uuid END AS "brandId",
  normalized NOT IN ('', '(unspecified)', 'generic', 'unbranded', 'generic / unbranded') AND cardinality(matches)<>1 AS create_brand
FROM matched;

-- Canonical five-character codes are allocated against the permanent roster,
-- including tombstones; the transaction holds Entity's write lock throughout.
DO $$ DECLARE target record; ordinal bigint := 0; code text; BEGIN
  FOR target IN SELECT "brandId" FROM brand_cutover_map WHERE create_brand ORDER BY source LOOP
    LOOP
      IF ordinal >= 28629151 THEN RAISE EXCEPTION 'Vendor shortcode namespace exhausted'; END IF;
      code := 'VEN-' ||
        substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 923521) % 31)::int + 1, 1) ||
        substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 29791) % 31)::int + 1, 1) ||
        substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 961) % 31)::int + 1, 1) ||
        substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ((ordinal / 31) % 31)::int + 1, 1) ||
        substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', (ordinal % 31)::int + 1, 1);
      ordinal := ordinal + 1;
      IF NOT EXISTS (SELECT 1 FROM "Entity" WHERE shortcode=code) THEN
        INSERT INTO "Entity" (id, kind, shortcode) VALUES (target."brandId", 'vendor', code);
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
END $$;
INSERT INTO "Vendor" (id, shortcode, name)
SELECT m."brandId", e.shortcode, m.name FROM brand_cutover_map m JOIN "Entity" e ON e.id=m."brandId" WHERE create_brand;

-- Fail closed before changing or dropping the source. NULL means unknown and
-- is one identity bucket for this preflight even though PostgreSQL permits it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Product" p JOIN brand_cutover_map m ON m.source=p.manufacturer
    WHERE p."deletedAt" IS NULL GROUP BY p.name, m."brandId" HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Brand cutover would collide live Product (name, brandId) identities; reconcile explicitly before retrying';
  END IF;
END $$;

-- Migration evidence is system-authored, not a manufactured member decision.
-- Keep the exact source bytes, including blank/sentinel values and tombstones.
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('cubby-system', 'Cubby system', 'cubby-system@system.invalid', false, now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO "AuditLog" ("entityKind", "entityId", action, changes, "userId", channel)
SELECT 'product', p.id, 'update', jsonb_build_object(
  'manufacturer', jsonb_build_object('from', p.manufacturer, 'to', NULL),
  'brandId', jsonb_build_object('from', NULL, 'to', v.shortcode),
  'migration', jsonb_build_object('from', NULL, 'to', '0009_unified_product_brands')),
  'cubby-system', 'system'
FROM "Product" p JOIN brand_cutover_map m ON m.source=p.manufacturer LEFT JOIN "Vendor" v ON v.id=m."brandId";
-- Retain active exceptions only when the old exact evidence was still current
-- and still means unknown. Every other decision remains visible but stale.
UPDATE "DataException" e SET "check"='product_brand', fingerprint=CASE
  WHEN m."brandId" IS NULL AND e.fingerprint='product_manufacturer:' || to_jsonb(p.manufacturer)::text
    THEN 'product_brand:null'
  ELSE 'product_brand:legacy:' || e.fingerprint END
FROM "Product" p JOIN brand_cutover_map m ON m.source=p.manufacturer
WHERE e."entityKind"='product' AND e."entityId"=p.id AND e."check"='product_manufacturer';
UPDATE "Product" p SET "brandId"=m."brandId" FROM brand_cutover_map m WHERE m.source=p.manufacturer;

-- Prepared candidates are retained display snapshots, not new evidence.
UPDATE "ImportPreparedLine" l SET candidates=(SELECT coalesce(jsonb_agg(
  CASE WHEN c ? 'manufacturer' THEN (c-'manufacturer') || jsonb_build_object('brandName', c->'manufacturer') ELSE c END), '[]'::jsonb)
  FROM jsonb_array_elements(l.candidates) c) WHERE jsonb_path_exists(l.candidates, '$[*].manufacturer');
UPDATE "PhotoGroupProposal" p SET "productCreate"=(p."productCreate"-'manufacturer') || jsonb_build_object(
  'brandId', v.shortcode, 'sourceManufacturer', p."productCreate"->'manufacturer')
FROM brand_cutover_map m LEFT JOIN "Vendor" v ON v.id=m."brandId"
WHERE p."productCreate"->>'manufacturer'=m.source;
--> statement-breakpoint
CREATE UNIQUE INDEX "Product_name_brandId_key" ON "Product" USING btree ("name","brandId") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Product_name_brandId_idx" ON "Product" USING btree ("name","brandId");--> statement-breakpoint
CREATE INDEX "Product_brand_active_idx" ON "Product" USING btree ("brandId") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Product_brandId_idx" ON "Product" USING btree ("brandId");--> statement-breakpoint
CREATE INDEX "Vendor_name_idx" ON "Vendor" USING btree ("name") WHERE "Vendor"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Vendor_systemKey_key" ON "Vendor" USING btree ("systemKey");--> statement-breakpoint
ALTER TABLE "Product" DROP COLUMN "manufacturer";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cubby_guard_generic_brand() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Vendor' THEN
    IF OLD."systemKey" IS NOT NULL AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'System Generic / Unbranded Brand cannot be changed, deleted or merged';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."systemKey" IS DISTINCT FROM OLD."systemKey" THEN
      RAISE EXCEPTION 'Vendor system designation cannot be changed';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- includes-deleted: system designation forbids these roles even for a tombstoned identity.
  IF EXISTS (SELECT 1 FROM "Vendor" WHERE id = NEW."vendorId" AND "systemKey" = 'generic-unbranded') THEN
    RAISE EXCEPTION 'Generic / Unbranded may only be assigned as a Product Brand';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Vendor_protect_generic_brand" BEFORE UPDATE OR DELETE ON "Vendor"
FOR EACH ROW EXECUTE FUNCTION cubby_guard_generic_brand();
CREATE TRIGGER "Purchase_reject_generic_seller" BEFORE INSERT OR UPDATE OF "vendorId" ON "Purchase"
FOR EACH ROW EXECUTE FUNCTION cubby_guard_generic_brand();
CREATE TRIGGER "VendorAccount_reject_generic_seller" BEFORE INSERT OR UPDATE OF "vendorId" ON "VendorAccount"
FOR EACH ROW EXECUTE FUNCTION cubby_guard_generic_brand();
CREATE TRIGGER "ExternalSource_reject_generic_issuer" BEFORE INSERT OR UPDATE OF "vendorId" ON "ExternalSource"
FOR EACH ROW EXECUTE FUNCTION cubby_guard_generic_brand();
