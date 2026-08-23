/**
 * Reads and writes specific to a location sweep.
 *
 * Kept apart from `crud.ts` because the sweep's two primitives have no other
 * caller and one deliberately narrow contract each: stock-only facts, and a
 * verification stamp that never touches the amount.
 */

import type { Amount } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import type {
  InventoryId,
  InventoryShortcode,
  LocationId,
  LocationShortcode,
  ProductId,
} from "@cubby/schemas/identifiers";
import {
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
} from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "~/server/db";
import { inventoryEntry } from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { stockOnly } from "./placement";

/**
 * Both id forms travel together on purpose: the planner and the wire speak
 * shortcodes, while the writes that follow need the uuids. Re-resolving one
 * from the other afterwards would be a second query per scan, on the hot path.
 *
 * The uuid is `entityId`, never `id`. Reusing `id` for it would make
 * `row.location.id` a uuid here and a shortcode on the wire — the same key
 * meaning two id-spaces, which is exactly the confusion the branded types
 * exist to prevent from compiling.
 */
export interface ProductStockRow {
  entityId: InventoryId;
  id: InventoryShortcode;
  amount: Amount;
  location: { entityId: LocationId; id: LocationShortcode; name: string };
}

/**
 * Every live STOCK row for a product, with its location.
 *
 * Stock-only is the whole point, and it is enforced here rather than left to
 * the caller: `loadProductInventoryEntries` returns both populations, so a
 * consumer that reached for it would happily offer to move a faucet out of the
 * wall it is plumbed into.
 */
export const getProductStockRows = async (
  db: Database,
  productId: ProductId,
): Promise<ProductStockRow[]> => {
  const rows = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, productId),
      stockOnly(),
      notDeleted(inventoryEntry),
    ),
    orderBy: inventoryEntry.createdAt,
    with: { location: true },
  });

  return rows
    .filter((row) => row.location && !row.location.deletedAt)
    .map((row) => ({
      entityId: row.id,
      id: unsafeInventoryShortcode(row.shortcode),
      amount: row.amount,
      location: {
        entityId: row.location.id,
        id: unsafeLocationShortcode(row.location.shortcode),
        name: row.location.name,
      },
    }));
};

/**
 * Record that a row was seen on its shelf. Stamps `verifiedAt` and nothing
 * else — a sweep observes presence, it does not count units, so re-sweeping a
 * correct shelf must leave every amount untouched.
 */
export const markInventoryEntryVerified = async (
  db: Database,
  id: InventoryId,
  actor: ActorContext,
): Promise<void> => {
  await getDb(db)
    .update(inventoryEntry)
    .set({ verifiedAt: new Date() })
    .where(and(eq(inventoryEntry.id, id), notDeleted(inventoryEntry)));

  await logAuditEntry(db, actor, {
    entityType: "inventory",
    entityId: id,
    action: "update",
  });
};

/**
 * Re-read specific stock rows by shortcode, dropping any that no longer exist.
 *
 * The sweep's commit path needs this because a full move onto an existing
 * destination row hard-deletes its source: strays queued minutes earlier can
 * legitimately be gone by the time the batch runs, and a missing row is a skip
 * rather than a failed batch.
 */
export const getLiveStockRowsByIds = async (
  db: Database,
  shortcodes: readonly InventoryShortcode[],
): Promise<ProductStockRow[]> => {
  if (shortcodes.length === 0) return [];

  const rows = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.shortcode, [...shortcodes]),
      stockOnly(),
      notDeleted(inventoryEntry),
    ),
    with: { location: true },
  });

  return rows
    .filter((row) => row.location && !row.location.deletedAt)
    .map((row) => ({
      entityId: row.id,
      id: unsafeInventoryShortcode(row.shortcode),
      amount: row.amount,
      location: {
        entityId: row.location.id,
        id: unsafeLocationShortcode(row.location.shortcode),
        name: row.location.name,
      },
    }));
};
