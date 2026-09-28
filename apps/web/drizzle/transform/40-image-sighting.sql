-- ImageSighting: entity -> non-entity child of Image (ADR 0005). The table and
-- its uuids stay; its identity (shortcode, identity FK, identity triggers,
-- Entity rows) goes. Its audit history moves onto the parent Image first, a
-- deliberate exception to ADR 0006's "Entity rows are never deleted".
-- Plain Postgres DDL and backfills, no BEGIN/COMMIT: the caller runs every
-- transform fragment in one transaction. Names match what Drizzle emits for
-- apps/web/src/server/db/schema.ts.

-- Relative checks at the end compare against these counts.
CREATE TEMP TABLE "_image_sighting_demotion_pre" AS
  SELECT (SELECT count(*) FROM "AuditLog") AS "auditTotal",
         (SELECT count(*) FROM "ImageSighting") AS "sightings";

-- 1. Drop the identity binding: the derived triggers keep an Entity row in
-- step with the payload, so they go before any Entity row is deleted.
DROP TRIGGER IF EXISTS "Entity_identity_insert" ON "ImageSighting";
DROP TRIGGER IF EXISTS "Entity_identity_soft_delete" ON "ImageSighting";
DROP TRIGGER IF EXISTS "Entity_identity_delete" ON "ImageSighting";
ALTER TABLE "ImageSighting" DROP CONSTRAINT "ImageSighting_entity_identity_fk";
DROP INDEX "ImageSighting_shortcode_unique";

-- 2. Rewrite each sighting's audit rows onto its Image. The Image is the
-- audit subject now, so the row is an update of the Image; the sighting's own
-- diff (null for every row written before this migration) nests under its id.
UPDATE "AuditLog" AS a
  SET "entityKind" = 'image',
      "entityId" = s."imageId",
      "action" = 'update',
      "changes" = jsonb_build_object(
        'sightings',
        jsonb_build_object(s."id"::text, COALESCE(a."changes", '{}'::jsonb))
      )
  FROM "ImageSighting" AS s
  WHERE a."entityKind" = 'imageSighting' AND a."entityId" = s."id";

-- 3. Guard: nothing may still point at a sighting identity. Audit rows whose
-- sighting row is gone cannot be rewritten (no parent Image); every other
-- reference is found through the foreign keys onto Entity, so a table another
-- slice adds is covered too.
DO $$
DECLARE
  fk record;
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "AuditLog" WHERE "entityKind" = 'imageSighting';
  IF n > 0 THEN
    RAISE EXCEPTION 'ImageSighting demotion: % AuditLog rows name a sighting that no longer exists', n;
  END IF;
  SELECT count(*) INTO n FROM "Entity"
    WHERE "mergedIntoId" IN (SELECT "id" FROM "ImageSighting");
  IF n > 0 THEN
    RAISE EXCEPTION 'ImageSighting demotion: % Entity rows were merged into a sighting', n;
  END IF;
  FOR fk IN
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint AS c
    JOIN pg_attribute AS a
      ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confrelid = '"Entity"'::regclass
      AND c.conrelid NOT IN ('"Entity"'::regclass, '"AuditLog"'::regclass)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s WHERE %I IN (SELECT "id" FROM "ImageSighting")',
      fk.tbl, fk.col
    ) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'ImageSighting demotion: % rows in %.% still reference a sighting identity', n, fk.tbl, fk.col;
    END IF;
  END LOOP;
END $$;

-- 4. Delete the identity rows, then the shortcode.
DELETE FROM "Entity" WHERE "kind" = 'imageSighting';
ALTER TABLE "ImageSighting" DROP COLUMN "shortcode";

-- 5. A sighting cannot outlive its Image.
ALTER TABLE "ImageSighting" DROP CONSTRAINT "ImageSighting_imageId_Image_id_fk";
ALTER TABLE "ImageSighting"
  ADD CONSTRAINT "ImageSighting_imageId_Image_id_fk"
  FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id")
  ON DELETE cascade ON UPDATE no action;

-- 6. `imageSighting` and its IMS- prefix leave the Entity CHECKs (after the
-- DELETE above, so no row violates the new rule).
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_kind_check";
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_shortcode_prefix_check";
ALTER TABLE "Entity"
  ADD CONSTRAINT "Entity_kind_check" CHECK ("Entity"."kind" IN ('product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory', 'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor', 'purchase', 'financialAccount', 'financialTransaction', 'wish', 'expense', 'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory', 'run', 'device', 'plant'));
ALTER TABLE "Entity"
  ADD CONSTRAINT "Entity_shortcode_prefix_check" CHECK ("Entity"."shortcode" IS NULL OR CASE "Entity"."kind" WHEN 'product' THEN "Entity"."shortcode" LIKE 'PRD-%' WHEN 'recipe' THEN "Entity"."shortcode" LIKE 'RCP-%' WHEN 'ingredient' THEN "Entity"."shortcode" LIKE 'ING-%' WHEN 'cookbook' THEN "Entity"."shortcode" LIKE 'CKB-%' WHEN 'location' THEN "Entity"."shortcode" LIKE 'LOC-%' WHEN 'inventory' THEN "Entity"."shortcode" LIKE 'INV-%' WHEN 'meal' THEN "Entity"."shortcode" LIKE 'MEL-%' WHEN 'ledgerParty' THEN "Entity"."shortcode" LIKE 'LPY-%' WHEN 'ledgerTransfer' THEN "Entity"."shortcode" LIKE 'LTR-%' WHEN 'project' THEN "Entity"."shortcode" LIKE 'PRJ-%' WHEN 'task' THEN "Entity"."shortcode" LIKE 'TSK-%' WHEN 'vendor' THEN "Entity"."shortcode" LIKE 'VEN-%' WHEN 'purchase' THEN "Entity"."shortcode" LIKE 'PUR-%' WHEN 'financialAccount' THEN "Entity"."shortcode" LIKE 'FAC-%' WHEN 'financialTransaction' THEN "Entity"."shortcode" LIKE 'FTX-%' WHEN 'wish' THEN "Entity"."shortcode" LIKE 'WSH-%' WHEN 'expense' THEN "Entity"."shortcode" LIKE 'EXP-%' WHEN 'image' THEN "Entity"."shortcode" LIKE 'IMG-%' WHEN 'planting' THEN "Entity"."shortcode" LIKE 'PLT-%' WHEN 'gardenEntry' THEN "Entity"."shortcode" LIKE 'GDE-%' WHEN 'vendorAccount' THEN "Entity"."shortcode" LIKE 'VACCT-%' WHEN 'productCategory' THEN "Entity"."shortcode" LIKE 'CAT-%' WHEN 'run' THEN "Entity"."shortcode" LIKE 'RUN-%' WHEN 'device' THEN "Entity"."shortcode" LIKE 'DEV-%' WHEN 'plant' THEN "Entity"."shortcode" LIKE 'PLANT-%' ELSE false END);

-- 7. Relative checks: audit history moved, none lost; no sighting identity
-- left; no sighting row lost.
DO $$
DECLARE
  pre record;
  n bigint;
BEGIN
  SELECT * INTO pre FROM "_image_sighting_demotion_pre";
  SELECT count(*) INTO n FROM "AuditLog";
  IF n <> pre."auditTotal" THEN
    RAISE EXCEPTION 'ImageSighting demotion: AuditLog total changed from % to %', pre."auditTotal", n;
  END IF;
  SELECT count(*) INTO n FROM "AuditLog" WHERE "entityKind" = 'imageSighting';
  IF n <> 0 THEN
    RAISE EXCEPTION 'ImageSighting demotion: % AuditLog rows still name imageSighting', n;
  END IF;
  SELECT count(*) INTO n FROM "Entity" WHERE "kind" = 'imageSighting';
  IF n <> 0 THEN
    RAISE EXCEPTION 'ImageSighting demotion: % Entity rows still have kind imageSighting', n;
  END IF;
  SELECT count(*) INTO n FROM "ImageSighting";
  IF n <> pre."sightings" THEN
    RAISE EXCEPTION 'ImageSighting demotion: ImageSighting rows changed from % to %', pre."sightings", n;
  END IF;
END $$;
DROP TABLE "_image_sighting_demotion_pre";
