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
INSERT INTO "JobInvalidationCapture" (key,"capturedAt")
VALUES ('derived:drain',now() AT TIME ZONE 'UTC');
