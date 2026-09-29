-- EntityLink (ADR 0007): the seven same-shaped join tables become one generic
-- link table. Ids and timestamps are kept; `from` is the owning side (wish,
-- purchase, project, garden entry, kit, blocked task, blocked project), per
-- packages/schemas/src/entity-links.ts. Dependencies had no deletedAt and
-- become soft-deletable. Plain DDL and backfills, no BEGIN/COMMIT: every
-- transform fragment runs in one transaction. Names match what Drizzle emits
-- for apps/web/src/server/db/schema.ts.

CREATE TEMP TABLE "_link_pre" ON COMMIT DROP AS
SELECT 'wishCandidate' AS "kind", count(*) AS "rows", count(*) FILTER (WHERE "deletedAt" IS NULL) AS "live" FROM "WishCandidate"
UNION ALL SELECT 'purchaseProduct', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL) FROM "PurchaseProduct"
UNION ALL SELECT 'projectTool', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL) FROM "ProjectToolUsage"
UNION ALL SELECT 'gardenEntryPlanting', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL) FROM "GardenEntryPlanting"
UNION ALL SELECT 'productComponent', count(*), count(*) FILTER (WHERE "deletedAt" IS NULL) FROM "ProductComponent"
UNION ALL SELECT 'taskDependency', count(*), count(*) FROM "TaskDependency"
UNION ALL SELECT 'projectDependency', count(*), count(*) FROM "ProjectDependency";
--> statement-breakpoint

CREATE TABLE "EntityLink" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "fromEntityId" uuid NOT NULL,
  "fromKind" text NOT NULL,
  "toEntityId" uuid NOT NULL,
  "toKind" text NOT NULL,
  "quantity" integer,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  "deletedAt" timestamp,
  CONSTRAINT "EntityLink_kind_check" CHECK (("kind", "fromKind", "toKind") IN (
    ('wishCandidate', 'wish', 'product'),
    ('purchaseProduct', 'purchase', 'product'),
    ('projectTool', 'project', 'product'),
    ('gardenEntryPlanting', 'gardenEntry', 'planting'),
    ('productComponent', 'product', 'product'),
    ('taskDependency', 'task', 'task'),
    ('projectDependency', 'project', 'project'))),
  CONSTRAINT "EntityLink_quantity_check" CHECK (CASE WHEN "kind" IN ('productComponent')
    THEN "quantity" IS NOT NULL AND "quantity" >= 1 ELSE "quantity" IS NULL END),
  CONSTRAINT "EntityLink_no_self_check" CHECK ("kind" NOT IN ('productComponent', 'taskDependency', 'projectDependency')
    OR "fromEntityId" <> "toEntityId")
);
--> statement-breakpoint
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_from_fk"
  FOREIGN KEY ("fromEntityId", "fromKind") REFERENCES "Entity" ("id", "kind");
--> statement-breakpoint
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_to_fk"
  FOREIGN KEY ("toEntityId", "toKind") REFERENCES "Entity" ("id", "kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "EntityLink_kind_from_to_key" ON "EntityLink" USING btree ("kind", "fromEntityId", "toEntityId")
  WHERE "EntityLink"."deletedAt" IS NULL;
--> statement-breakpoint
CREATE INDEX "EntityLink_to_kind_idx" ON "EntityLink" USING btree ("toEntityId", "kind")
  WHERE "EntityLink"."deletedAt" IS NULL;
--> statement-breakpoint

INSERT INTO "EntityLink" ("id", "kind", "fromEntityId", "fromKind", "toEntityId", "toKind", "quantity", "createdAt", "updatedAt", "deletedAt")
SELECT "id", 'wishCandidate', "wishId", 'wish', "productId", 'product', NULL::integer, "createdAt", "updatedAt", "deletedAt" FROM "WishCandidate"
UNION ALL
SELECT "id", 'purchaseProduct', "purchaseId", 'purchase', "productId", 'product', NULL, "createdAt", "updatedAt", "deletedAt" FROM "PurchaseProduct"
UNION ALL
SELECT "id", 'projectTool', "projectId", 'project', "productId", 'product', NULL, "createdAt", "updatedAt", "deletedAt" FROM "ProjectToolUsage"
UNION ALL
SELECT "id", 'gardenEntryPlanting', "gardenEntryId", 'gardenEntry', "plantingId", 'planting', NULL, "createdAt", "updatedAt", "deletedAt" FROM "GardenEntryPlanting"
UNION ALL
SELECT "id", 'productComponent', "parentProductId", 'product', "componentProductId", 'product', "quantity", "createdAt", "updatedAt", "deletedAt" FROM "ProductComponent"
UNION ALL
SELECT "id", 'taskDependency', "taskId", 'task', "blockedByTaskId", 'task', NULL, "createdAt", "updatedAt", NULL::timestamp FROM "TaskDependency"
UNION ALL
SELECT "id", 'projectDependency', "projectId", 'project', "blockedByProjectId", 'project', NULL, "createdAt", "updatedAt", NULL FROM "ProjectDependency";
--> statement-breakpoint

-- Installed after the copy (production has no live link to a deleted entity;
-- the post-check below proves it). Identical to derived-ddl.ts.
CREATE OR REPLACE FUNCTION "entity_link_require_live_endpoints"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Entity"
    WHERE "id" IN (NEW."fromEntityId", NEW."toEntityId")
      AND "deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'EntityLink % (%) names a deleted entity: % -> %',
      NEW."id", NEW."kind", NEW."fromEntityId", NEW."toEntityId"
      USING ERRCODE = '23503', CONSTRAINT = 'EntityLink_live_endpoints_check';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "EntityLink_live_endpoints" ON "EntityLink";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "EntityLink_live_endpoints" AFTER INSERT OR UPDATE ON "EntityLink"
  FOR EACH ROW WHEN (NEW."deletedAt" IS NULL)
  EXECUTE FUNCTION "entity_link_require_live_endpoints"();
--> statement-breakpoint

DROP TABLE "WishCandidate";
--> statement-breakpoint
DROP TABLE "PurchaseProduct";
--> statement-breakpoint
DROP TABLE "ProjectToolUsage";
--> statement-breakpoint
DROP TABLE "GardenEntryPlanting";
--> statement-breakpoint
DROP TABLE "ProductComponent";
--> statement-breakpoint
DROP TABLE "TaskDependency";
--> statement-breakpoint
DROP TABLE "ProjectDependency";
--> statement-breakpoint

DO $$
DECLARE
  drift text;
BEGIN
  SELECT string_agg(coalesce(pre."kind", post."kind") || ' ' || coalesce(pre."rows", 0) || '/' || coalesce(pre."live", 0)
      || '->' || coalesce(post."rows", 0) || '/' || coalesce(post."live", 0), ', ')
  INTO drift
  FROM "_link_pre" pre
  FULL JOIN (
    SELECT "kind", count(*) AS "rows", count(*) FILTER (WHERE "deletedAt" IS NULL) AS "live"
    FROM "EntityLink" GROUP BY 1
  ) post USING ("kind")
  WHERE coalesce(pre."rows", 0) <> coalesce(post."rows", 0)
     OR coalesce(pre."live", 0) <> coalesce(post."live", 0);
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'EntityLink copy changed link counts (total/live): %', drift;
  END IF;

  SELECT string_agg(l."kind" || ' ' || l."id", ', ')
  INTO drift
  FROM "EntityLink" l
  JOIN "Entity" e ON e."id" IN (l."fromEntityId", l."toEntityId")
  WHERE l."deletedAt" IS NULL AND e."deletedAt" IS NOT NULL;
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'EntityLink copy produced live links to deleted entities: %', drift;
  END IF;
END $$;
