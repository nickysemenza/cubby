-- Durable entity identity catch-up (ADR 0006). Idempotent; run right after
-- the PR's deploy finishes, while queue delivery is still paused. It mirrors
-- what the previous build wrote between entity-identity.sql and the deploy:
-- gallery/cover/logo writes to the legacy columns, merges (whose survivor
-- audit entries carry the loser ids), data exceptions, and proposal codes.
-- Payload creates and deletes need no catch-up: the triggers mirrored them.
BEGIN;

INSERT INTO "EntityAttachment"
  ("subjectEntityId", "imageId", "role", "sortOrder", "purpose", "documentKind", "createdAt", "updatedAt")
SELECT j."productId", j."imageId", 'attachment', j."sortOrder", j."purpose", NULL, j."createdAt", j."updatedAt"
FROM "ProductImage" j
WHERE j."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EntityAttachment" a
    WHERE a."subjectEntityId" = j."productId" AND a."imageId" = j."imageId" AND a."deletedAt" IS NULL
  );

INSERT INTO "EntityAttachment"
  ("subjectEntityId", "imageId", "role", "sortOrder", "purpose", "documentKind", "createdAt", "updatedAt")
SELECT j."locationId", j."imageId", 'attachment', j."sortOrder", NULL, NULL, j."createdAt", j."updatedAt"
FROM "LocationImage" j
WHERE j."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EntityAttachment" a
    WHERE a."subjectEntityId" = j."locationId" AND a."imageId" = j."imageId" AND a."deletedAt" IS NULL
  );

INSERT INTO "EntityAttachment"
  ("subjectEntityId", "imageId", "role", "sortOrder", "purpose", "documentKind", "createdAt", "updatedAt")
SELECT j."gardenEntryId", j."imageId", 'attachment', j."sortOrder", NULL, NULL, j."createdAt", j."updatedAt"
FROM "GardenEntryImage" j
WHERE j."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EntityAttachment" a
    WHERE a."subjectEntityId" = j."gardenEntryId" AND a."imageId" = j."imageId" AND a."deletedAt" IS NULL
  );

INSERT INTO "EntityAttachment"
  ("subjectEntityId", "imageId", "role", "sortOrder", "purpose", "documentKind", "createdAt", "updatedAt")
SELECT j."recipeId", j."imageId", 'attachment', j."sortOrder", NULL, NULL, j."createdAt", j."updatedAt"
FROM "RecipeImage" j
WHERE j."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EntityAttachment" a
    WHERE a."subjectEntityId" = j."recipeId" AND a."imageId" = j."imageId" AND a."deletedAt" IS NULL
  );

INSERT INTO "EntityAttachment"
  ("subjectEntityId", "imageId", "role", "sortOrder", "purpose", "documentKind", "createdAt", "updatedAt")
SELECT j."mealId", j."imageId", 'attachment', j."sortOrder", NULL, NULL, j."createdAt", j."updatedAt"
FROM "MealImage" j
WHERE j."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EntityAttachment" a
    WHERE a."subjectEntityId" = j."mealId" AND a."imageId" = j."imageId" AND a."deletedAt" IS NULL
  );

INSERT INTO "EntityAttachment"
  ("subjectEntityId", "imageId", "role", "sortOrder", "purpose", "documentKind", "createdAt", "updatedAt")
SELECT j."taskId", j."imageId", 'attachment', j."sortOrder", NULL, NULL, j."createdAt", j."updatedAt"
FROM "TaskImage" j
WHERE j."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EntityAttachment" a
    WHERE a."subjectEntityId" = j."taskId" AND a."imageId" = j."imageId" AND a."deletedAt" IS NULL
  );

INSERT INTO "EntityAttachment"
  ("subjectEntityId", "imageId", "role", "sortOrder", "purpose", "documentKind", "createdAt", "updatedAt")
SELECT j."purchaseId", j."imageId", 'attachment', j."sortOrder", NULL, j."documentKind", j."createdAt", j."updatedAt"
FROM "PurchaseImage" j
WHERE j."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EntityAttachment" a
    WHERE a."subjectEntityId" = j."purchaseId" AND a."imageId" = j."imageId" AND a."deletedAt" IS NULL
  );

INSERT INTO "EntityAttachment"
  ("subjectEntityId", "imageId", "role", "sortOrder", "purpose", "documentKind", "createdAt", "updatedAt")
SELECT j."projectId", j."imageId", 'attachment', j."sortOrder", NULL, NULL, j."createdAt", j."updatedAt"
FROM "ProjectImage" j
WHERE j."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EntityAttachment" a
    WHERE a."subjectEntityId" = j."projectId" AND a."imageId" = j."imageId" AND a."deletedAt" IS NULL
  );

-- A tombstoned owner's cover is soft-deleted with it (ADR 0006).
INSERT INTO "EntityAttachment"
  ("subjectEntityId", "imageId", "role", "sortOrder", "createdAt", "updatedAt", "deletedAt")
SELECT o."id", o."coverImageId", 'cover', 0, o."createdAt", o."updatedAt", o."deletedAt"
FROM "Cookbook" o
WHERE o."coverImageId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EntityAttachment" a
    WHERE a."subjectEntityId" = o."id" AND a."role" = 'cover'
  );

-- A tombstoned owner's logo is soft-deleted with it (ADR 0006).
INSERT INTO "EntityAttachment"
  ("subjectEntityId", "imageId", "role", "sortOrder", "createdAt", "updatedAt", "deletedAt")
SELECT o."id", o."logoImageId", 'logo', 0, o."createdAt", o."updatedAt", o."deletedAt"
FROM "Vendor" o
WHERE o."logoImageId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EntityAttachment" a
    WHERE a."subjectEntityId" = o."id" AND a."role" = 'logo'
  );

-- A retry key moves only onto the live association it was scoped to; a
-- targeted-but-detached file keeps nothing.
UPDATE "EntityAttachment" a
SET "idempotencyKey" = i."idempotencyKey"
FROM "Image" i
WHERE i."id" = a."imageId"
  AND i."idempotencyKey" IS NOT NULL AND i."deletedAt" IS NULL
  AND i."targetId" = a."subjectEntityId"
  AND a."deletedAt" IS NULL AND a."idempotencyKey" IS NULL;

-- Merge redirects from the survivors' audit evidence: each merge writes an
-- update entry on the survivor whose `changes.mergedFrom.to` lists the loser
-- ids. Ingredient merges record alias strings and hard-delete their losers,
-- so they cannot be reconstructed and are left as plain tombstones.
UPDATE "Entity" e
SET "mergedIntoId" = a."entityId"
FROM "AuditLog" a
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(a."changes"->'mergedFrom'->'to') = 'array'
    THEN a."changes"->'mergedFrom'->'to' ELSE '[]'::jsonb END
) loser
WHERE a."action" = 'update'
  AND a."changes" ? 'mergedFrom'
  AND loser ~ '^[0-9a-f-]{36}$'
  AND e."id" = loser::uuid
  AND e."kind" = a."entityType"
  AND e."id" <> a."entityId"
  AND e."deletedAt" IS NOT NULL
  AND e."mergedIntoId" IS NULL;

-- Path-compress so every redirect is one hop to the final survivor.
DO $$
DECLARE
  changed integer;
  rounds integer := 0;
BEGIN
  LOOP
    UPDATE "Entity" e
    SET "mergedIntoId" = s."mergedIntoId"
    FROM "Entity" s
    WHERE e."mergedIntoId" = s."id" AND s."mergedIntoId" IS NOT NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    EXIT WHEN changed = 0;
    rounds := rounds + 1;
    IF rounds > 20 THEN
      RAISE EXCEPTION 'merge redirects do not converge: a cycle in merge evidence';
    END IF;
  END LOOP;
END $$;

INSERT INTO "DataException"
  ("entityId", "entityKind", "check", "reason", "note", "fingerprint", "createdAt", "updatedAt")
SELECT owner."id", owner."kind", x->>'check', x->>'reason', x->>'note', x->>'fingerprint', now(), now()
FROM (
  SELECT "id", 'product' AS "kind", "dataExceptions" FROM "Product"
  UNION ALL
  SELECT "id", 'purchase', "dataExceptions" FROM "Purchase"
) owner
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(owner."dataExceptions", '[]'::jsonb)) x
ON CONFLICT ("entityId", "check") DO NOTHING;

UPDATE "PhotoGroupProposal" p
SET "productCreateCategoryId" = c."id"
FROM "ProductCategory" c
WHERE p."productCreateCategoryId" IS NULL
  AND c."shortcode" = p."productCreate"->>'categoryId';

UPDATE "PhotoGroupProposal" p
SET "inventoryOwnerPartyId" = l."id"
FROM "LedgerParty" l
WHERE p."inventoryOwnerPartyId" IS NULL
  AND l."shortcode" = p."inventory"->>'ownerPartyId';

-- The codes now live in the FK columns.
UPDATE "PhotoGroupProposal"
SET "productCreate" = "productCreate" - 'categoryId'
WHERE "productCreate" ? 'categoryId';
UPDATE "PhotoGroupProposal"
SET "inventory" = "inventory" - 'ownerPartyId'
WHERE "inventory" ? 'ownerPartyId';

COMMIT;
