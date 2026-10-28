-- Retain each displayed Cost while the existing drain captures its operands.
-- Never replace a member-edit ticket, retry state, or its priority.
INSERT INTO "WorkItem" (drain,target,ref,priority)
SELECT 'derived:drain','product.cost',p.id,2
FROM "Product" p
JOIN "DerivedValue" v ON v."entityId"=p.id AND v.key='cost'
WHERE p."deletedAt" IS NULL
  AND v.value->>'kind'='service_charge'
  AND NOT v.value ? 'chargeTotal'
ON CONFLICT (target,ref) DO NOTHING;
--> statement-breakpoint
-- Scalar values keep their shape; only private decision evidence is missing.
INSERT INTO "WorkItem" (drain,target,ref,priority)
SELECT 'derived:drain','product.'||v.key,p.id,2
FROM "Product" p JOIN "DerivedValue" v ON v."entityId"=p.id AND v.kind='product'
WHERE p."deletedAt" IS NULL
  AND v.key IN ('price','ledgerExpectedQuantity','quantityVariance','food')
  AND jsonb_typeof(v."decidedBy"->'evidence') IS DISTINCT FROM 'object'
UNION ALL
SELECT 'derived:drain','inventory.valuation',i.id,2
FROM "InventoryEntry" i JOIN "DerivedValue" v ON v."entityId"=i.id AND v.kind='inventory' AND v.key='valuation'
WHERE i."deletedAt" IS NULL
  AND jsonb_typeof(v."decidedBy"->'evidence') IS DISTINCT FROM 'object'
ON CONFLICT (target,ref) DO NOTHING;
--> statement-breakpoint
INSERT INTO "JobInvalidationCapture" (key,"capturedAt")
VALUES ('derived:drain',now() AT TIME ZONE 'UTC');
