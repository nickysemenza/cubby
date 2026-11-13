import type { PurchaseId, VendorId } from "@cubby/schemas/identifiers";

import { planSlotCollisions } from "~/server/generic/merge/repo/collisions";
import { mergeNotes } from "~/server/lib/merge-notes";
/** Reads: all live Purchases id/vendorId/orderId/notes on the keeper and ordered loser Vendors. Null order ids never collide. */
export function vendorPurchaseFolds<
  Row extends {
    id: PurchaseId;
    vendorId: VendorId;
    orderId: string | null;
    notes: string | null;
  },
>(keepId: string, losers: readonly string[], purchases: readonly Row[]) {
  const order = [keepId, ...losers];
  const rows = [...purchases].sort(
    (a, b) =>
      order.indexOf(a.vendorId) - order.indexOf(b.vendorId) ||
      a.id.localeCompare(b.id),
  );
  const slotted = planSlotCollisions({
    keeperRows: rows.filter((row) => row.vendorId === keepId),
    loserRows: rows.filter((row) => row.vendorId !== keepId),
    slotKey: (row) => row.orderId,
  });
  return {
    folded: slotted.absorb.flatMap(({ into, rows: donors }) => {
      const notes = mergeNotes(into.notes, ...donors.map((row) => row.notes));
      return donors.map((row) => ({
        deadId: row.id,
        survivorId: into.id,
        vendorId: row.vendorId,
        notes,
      }));
    }),
    repointed: slotted.repoint.map((row) => ({
      id: row.id,
      vendorId: row.vendorId,
    })),
  };
}
