/**
 * Scan-into-location: the single owner of "a code was read while standing at a
 * location, now what".
 *
 * It lives server-side rather than being composed on the client for two
 * reasons. First, it must be atomic — two reads of the same product a moment
 * apart can both observe "not stocked here" and race to create, which the
 * partial unique index on `(productId, locationId, placement)` turns into a
 * raw 23505 the UI can do nothing with. Second, the decision depends on
 * `placement`, and the obvious client-side read (`loadProductInventoryEntries`)
 * does not filter it — a resolver built on that would cheerfully offer to move
 * a faucet out of the wall it is plumbed into.
 *
 * The branching itself is pure and lives in `scan-plan.ts`.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type {
  InventoryId,
  LocationId,
  LocationShortcode,
} from "@cubby/schemas/identifiers";
import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import type {
  ResolveScanStraysInput,
  ResolveScanStraysOut,
  ScanAtLocationInput,
  ScanAtLocationOut,
} from "@cubby/schemas/scan";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { runWithConflictRecovery } from "~/server/errors/db-errors";
import {
  createInventoryEntry,
  getLiveStockRowsByIds,
  getProductStockRows,
  markInventoryEntryVerified,
  moveInventoryEntries,
} from "~/server/repo/inventory";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { runMutationSideEffects } from "./mutation-side-effects";
import { findOrCreateByCode } from "./product-orchestration.service";
import { planScan, type ScanFacts } from "./scan-plan";

/**
 * One scanned object is one unit. A sweep records presence, so there is no
 * quantity to ask for and nothing for the caller to get wrong.
 */
const OBSERVED_AMOUNT = { value: 1, unit: "each" } as const;

/** The partial unique index a concurrent create collides with. */
const SLOT_CONSTRAINT = "InventoryEntry_productId_locationId_key";

const resolveLocation = async (
  db: Database,
  shortcode: LocationShortcode,
): Promise<LocationId> => {
  const id = await resolveLiveShortcode(db, shortcode, "location");
  if (!id) {
    throw createAppError(
      "LOCATION_NOT_FOUND",
      `No location found for ${shortcode}.`,
    );
  }
  return unsafeLocationId(id);
};

export async function scanAtLocation(
  db: Database,
  usdaClient: USDAClient,
  upcLookupClient: UPCLookupClient,
  input: ScanAtLocationInput,
  actor: ActorContext,
): Promise<ScanAtLocationOut> {
  const locationId = await resolveLocation(db, input.locationId);
  const { product, created } = await findOrCreateByCode(
    db,
    usdaClient,
    upcLookupClient,
    input.code,
    actor,
  );

  const productEntityId = await resolveLiveShortcode(db, product.id, "product");
  if (!productEntityId) {
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      `Product ${product.id} could not be resolved after lookup.`,
    );
  }
  const productId = unsafeProductId(productEntityId);

  const stockRows = await getProductStockRows(db, productId);
  const facts: ScanFacts = {
    product: { id: product.id, name: product.name },
    stock: stockRows.map((row) => ({
      id: row.shortcode,
      amount: row.amount,
      location: { id: row.location.shortcode, name: row.location.name },
    })),
  };
  const plan = planScan(facts, input.locationId);

  const productOut = { id: product.id, name: product.name, created };
  const now = new Date();

  if (plan.kind === "decide") {
    // Nothing is written mid-sweep. The strays ride back to the client and are
    // committed together at the end, which is what keeps a sixty-book sweep
    // down to one decision.
    return {
      outcome: "queued",
      product: productOut,
      strays: [...plan.strays],
      sideEffects: { backgroundBatches: [] },
    };
  }

  if (plan.kind === "confirm") {
    const entryId = stockRows.find((row) => row.shortcode === plan.entryId)?.id;
    if (!entryId) {
      throw createAppError(
        "INVENTORY_NOT_FOUND",
        `Inventory entry ${plan.entryId} disappeared mid-scan.`,
      );
    }
    await markInventoryEntryVerified(db, entryId, actor);
    const backgroundBatches = await runMutationSideEffects(db, {
      action: "updated",
      entity: { entityType: "inventory", entityId: entryId },
      source: "inventory.scanAtLocation",
    });
    return {
      outcome: "confirmed",
      product: productOut,
      strays: [...plan.strays],
      sideEffects: { backgroundBatches },
    };
  }

  // `add`. The read above and this insert are not one statement, so a second
  // scan of the same code can land in between. Rather than reserve against
  // that, let the unique index arbitrate and converge on the winner: the row
  // exists either way, and confirming it is exactly what the second scan meant.
  return await runWithConflictRecovery<ScanAtLocationOut>(
    async () => {
      const entry = await createInventoryEntry(
        db,
        {
          productId,
          locationId,
          amount: OBSERVED_AMOUNT,
          verifiedAt: now,
        },
        actor,
      );
      const entityId = await resolveLiveShortcode(db, entry.id, "inventory");
      const backgroundBatches = entityId
        ? await runMutationSideEffects(db, {
            action: "created",
            entity: {
              entityType: "inventory",
              entityId: unsafeInventoryId(entityId),
            },
            source: "inventory.scanAtLocation",
          })
        : [];
      return {
        outcome: "added" as const,
        product: productOut,
        strays: [...plan.strays],
        sideEffects: { backgroundBatches },
      };
    },
    async () => {
      const rows = await getProductStockRows(db, productId);
      const here = rows.find(
        (row) => row.location.shortcode === input.locationId,
      );
      if (!here)
        throw createAppError("INVENTORY_NOT_FOUND", "Scan lost a race");
      await markInventoryEntryVerified(db, here.id, actor);
      return {
        outcome: "confirmed" as const,
        product: productOut,
        strays: [...plan.strays],
        sideEffects: { backgroundBatches: [] },
      };
    },
    SLOT_CONSTRAINT,
  );
}

/**
 * Commit the strays a sweep turned up, at the end, in one move.
 *
 * Every entry is re-read first rather than trusted from the client's preview.
 * Two scans can queue strays that share a source row, and a full move onto an
 * existing destination row HARD-deletes its source — so by the time the batch
 * runs, some ids legitimately no longer exist. That is a skip, not a failure:
 * one stale row is no reason to strand the other fifty.
 */
export async function resolveScanStrays(
  db: Database,
  input: ResolveScanStraysInput,
  actor: ActorContext,
): Promise<ResolveScanStraysOut> {
  const targetLocationId = await resolveLocation(db, input.targetLocationId);

  const requested = new Map(input.moves.map((move) => [move.entryId, move]));
  const live = await getLiveStockRowsByIds(db, [...requested.keys()]);
  const liveByShortcode = new Map(live.map((row) => [row.shortcode, row]));

  const skipped: ResolveScanStraysOut["skipped"] = [];
  const items: Array<{
    inventoryEntryId: InventoryId;
    targetLocationId: LocationId;
    quantity?: { value: number; unit: string };
  }> = [];

  for (const [entryId, move] of requested) {
    const row = liveByShortcode.get(entryId);
    if (!row) {
      skipped.push({
        entryId,
        reason: "That entry was already moved or removed.",
      });
      continue;
    }
    if (row.location.shortcode === input.targetLocationId) {
      skipped.push({ entryId, reason: "Already here." });
      continue;
    }
    items.push({
      inventoryEntryId: row.id,
      targetLocationId,
      ...(move.quantity ? { quantity: move.quantity } : {}),
    });
  }

  if (items.length === 0) {
    return { moved: 0, skipped, sideEffects: { backgroundBatches: [] } };
  }

  const moved = await moveInventoryEntries(db, { items }, actor);
  const backgroundBatches = await runMutationSideEffects(db, {
    action: "updated",
    entity: { entityType: "location", entityId: targetLocationId },
    source: "inventory.resolveScanStrays",
  });

  return {
    moved: moved.length,
    skipped,
    sideEffects: { backgroundBatches },
  };
}
