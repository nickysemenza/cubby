import type {
  LedgerPartyId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import type { InventoryPlacement } from "@cubby/schemas/inventory";
import type { InventoryOwnershipMode } from "@cubby/schemas/inventory-ownership";
import { and, eq, isNull } from "drizzle-orm";

import { inventoryEntry } from "~/server/db/schema";

export type InventoryRawOwnership = {
  ownershipMode: InventoryOwnershipMode;
  ownerLedgerPartyId: LedgerPartyId | null;
};

export const inventorySlotKey = (slot: {
  productId: ProductId;
  locationId: LocationId;
  placement: InventoryPlacement;
  ownershipMode: InventoryOwnershipMode;
  ownerLedgerPartyId: LedgerPartyId | null;
}): string =>
  [
    slot.productId,
    slot.locationId,
    slot.placement,
    slot.ownershipMode,
    slot.ownerLedgerPartyId ?? "none",
  ].join("\u0000");

export const inventoryOwnershipSlotCondition = (
  ownership: InventoryRawOwnership,
) =>
  and(
    eq(inventoryEntry.ownershipMode, ownership.ownershipMode),
    ownership.ownerLedgerPartyId === null
      ? isNull(inventoryEntry.ownerLedgerPartyId)
      : eq(inventoryEntry.ownerLedgerPartyId, ownership.ownerLedgerPartyId),
  );

export const assertValidRawInventoryOwnership = (
  ownership: InventoryRawOwnership,
): void => {
  if (
    (ownership.ownershipMode === "person") !==
    (ownership.ownerLedgerPartyId !== null)
  ) {
    throw new Error(
      "Person ownership requires an owner; inherit and unassigned ownership clear it",
    );
  }
};

export const inventorySnapshotToken = async (
  rows: ReadonlyArray<{
    id: string;
    productId: ProductId;
    locationId: LocationId;
    placement: InventoryPlacement;
    ownershipMode: InventoryOwnershipMode;
    ownerLedgerPartyId: LedgerPartyId | null;
    amount: unknown;
  }>,
): Promise<string> => {
  const snapshot = rows
    .map((row) => ({
      id: row.id,
      productId: row.productId,
      locationId: row.locationId,
      placement: row.placement,
      ownershipMode: row.ownershipMode,
      ownerLedgerPartyId: row.ownerLedgerPartyId,
      amount: row.amount,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(snapshot)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};
