-- Run only after ownership-aware server/callers are deployed and verified.
-- This changes uniqueness, not image processing activation (which stays off).
BEGIN;
LOCK TABLE "InventoryEntry" IN SHARE ROW EXCLUSIVE MODE;
CREATE UNIQUE INDEX "InventoryEntry_ownership_slot_key" ON "InventoryEntry" (
  "productId", "locationId", placement, "ownershipMode",
  coalesce("ownerLedgerPartyId", '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE "deletedAt" IS NULL;
DROP INDEX "InventoryEntry_productId_locationId_key";
ALTER INDEX "InventoryEntry_ownership_slot_key" RENAME TO "InventoryEntry_productId_locationId_key";
DROP INDEX "AiAnalysis_active_key";
CREATE UNIQUE INDEX "AiAnalysis_active_key" ON "AiAnalysis" (
  "entityType", "entityId", feature, model, "promptVersion", "inputFingerprint",
  coalesce(provider, ''), coalesce("resultSchemaRevision", 0)
) WHERE "deletedAt" IS NULL;
COMMIT;
