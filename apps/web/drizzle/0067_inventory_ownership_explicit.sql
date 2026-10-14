-- Inventory ownership joins the shared inheritance-mode vocabulary: a named
-- person (`person`) and household stock (`unassigned`) both become `explicit`,
-- told apart by the owner. Existing rows and stored photo proposals are
-- rewritten in place; nothing is deleted.
ALTER TABLE "InventoryEntry" DROP CONSTRAINT "InventoryEntry_ownership_valid";--> statement-breakpoint
UPDATE "InventoryEntry" SET "ownershipMode" = 'explicit' WHERE "ownershipMode" IN ('person', 'unassigned');--> statement-breakpoint
-- A proposal's household stock keeps its meaning through `household: true`;
-- a person proposal keeps its owner in the inventoryOwnerPartyId column.
UPDATE "PhotoGroupProposal" SET "inventory" = jsonb_set("inventory", '{ownershipMode}', '"explicit"') || '{"household": true}'::jsonb WHERE "inventory"->>'ownershipMode' = 'unassigned';--> statement-breakpoint
UPDATE "PhotoGroupProposal" SET "inventory" = jsonb_set("inventory", '{ownershipMode}', '"explicit"') WHERE "inventory"->>'ownershipMode' = 'person';--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_ownershipMode_check" CHECK ("InventoryEntry"."ownershipMode" IN ('inherit', 'explicit'));--> statement-breakpoint
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_ownership_valid" CHECK ("InventoryEntry"."ownershipMode" = 'explicit' OR "InventoryEntry"."ownerLedgerPartyId" IS NULL);
