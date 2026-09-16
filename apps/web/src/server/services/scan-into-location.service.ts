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

import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import type {
  ResolveScanStraysInput,
  ResolveScanStraysOut,
  ScanAtLocationInput,
  ScanAtLocationOut,
} from "@cubby/schemas/scan";

import type { UpcLookupPort } from "~/server/clients/upc-lookup";
import type { UsdaFoodLookupPort } from "~/server/clients/usda";
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
import {
  resolveCreatedOrInvariant,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";

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

type ResolvedMoveItem = Parameters<
  typeof moveInventoryEntries
>[1]["items"][number];

export async function scanAtLocation(
  db: Database,
  usdaClient: UsdaFoodLookupPort,
  upcLookupClient: UpcLookupPort,
  input: ScanAtLocationInput,
  actor: ActorContext,
): Promise<ScanAtLocationOut> {
  const locationId = await resolveOrThrow(db, "location", input.locationId);

  // A Cubby product label resolves by lookup and a raw scan is classified
  // first; only an external code can name a product we have never seen.
  const { product, created } = await findOrCreateByCode(
    db,
    usdaClient,
    upcLookupClient,
    input.code,
    actor,
  );

  // Invariant, not a 404: `findOrCreateByCode` just handed us this code, so a
  // miss means the write path broke its own contract rather than a caller
  // naming an absent row.
  const productId = await resolveCreatedOrInvariant(db, "product", product.id);

  const stockRows = await getProductStockRows(db, productId);
  const facts: ScanFacts = {
    product: { id: product.id, name: product.name },
    stock: stockRows.map((row) => ({
      id: row.id,
      amount: row.amount,
      location: { id: row.location.id, name: row.location.name },
    })),
  };
  const plan = planScan(facts, input.locationId);

  const productOut = {
    id: product.id,
    name: product.name,
    created,
    manufacturer: product.manufacturer,
    hasPrice: product.pricing.effectivePrice != null,
  };
  const now = new Date();

  if (plan.kind === "decide") {
    // Nothing is written mid-sweep. The strays ride back to the client and are
    // committed together at the end, which is what keeps a sixty-book sweep
    // down to one decision.
    return {
      outcome: "queued",
      product: productOut,
      strays: [...plan.strays],
      sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
    };
  }

  if (plan.kind === "confirm") {
    const entryId = stockRows.find((row) => row.id === plan.entryId)?.entityId;
    if (!entryId) {
      throw createAppError(
        "INVENTORY_NOT_FOUND",
        `Inventory entry ${plan.entryId} disappeared mid-scan.`,
      );
    }
    await markInventoryEntryVerified(db, entryId, actor);
    await runMutationSideEffects(db, {
      action: "updated",
      entity: { entity: "inventory", id: entryId },
      source: "inventory.scanAtLocation",
    });
    return {
      outcome: "confirmed",
      product: productOut,
      strays: [...plan.strays],
      sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
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
      // Not a ternary that degrades to `[]`: swallowing a miss here would drop
      // the search/embedding refresh for a row that was just created, silently.
      const entityId = await resolveCreatedOrInvariant(
        db,
        "inventory",
        entry.id,
      );
      await runMutationSideEffects(db, {
        action: "created",
        entity: { entity: "inventory", id: entityId },
        source: "inventory.scanAtLocation",
      });
      return {
        outcome: "added" as const,
        product: productOut,
        strays: [...plan.strays],
        sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
      };
    },
    async () => {
      const rows = await getProductStockRows(db, productId);
      const here = rows.find((row) => row.location.id === input.locationId);
      if (!here)
        throw createAppError("INVENTORY_NOT_FOUND", "Scan lost a race");
      await markInventoryEntryVerified(db, here.entityId, actor);
      return {
        outcome: "confirmed" as const,
        product: productOut,
        strays: [...plan.strays],
        sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
      };
    },
    SLOT_CONSTRAINT,
  );
}

/**
 * Commit the strays a sweep turned up, at the end, in one move.
 *
 * Every entry is re-read first rather than trusted from the client's preview.
 * Two things can have changed since a stray was queued: it may already sit at
 * the target (a full move to an empty destination keeps the row and its id),
 * or its id may be gone entirely (a move ONTO an existing row sums the
 * quantities and HARD-deletes the source). Both are skips, not failures, and
 * they are reported apart — one stale row is no reason to strand the other
 * fifty, and "already here" is not the same fact as "already moved".
 */
export async function resolveScanStrays(
  db: Database,
  input: ResolveScanStraysInput,
  actor: ActorContext,
): Promise<ResolveScanStraysOut> {
  const targetLocationId = await resolveOrThrow(
    db,
    "location",
    input.targetLocationId,
  );

  const requested = new Map(input.moves.map((move) => [move.entryId, move]));
  const live = await getLiveStockRowsByIds(db, [...requested.keys()]);
  const liveByShortcode = new Map(live.map((row) => [row.id, row]));

  const skipped: ResolveScanStraysOut["skipped"] = [];
  const items: ResolvedMoveItem[] = [];

  for (const [entryId, move] of requested) {
    const row = liveByShortcode.get(entryId);
    if (!row) {
      skipped.push({
        entryId,
        reason: "already-moved",
        message: "That entry was already moved or removed.",
      });
      continue;
    }
    if (row.location.id === input.targetLocationId) {
      skipped.push({
        entryId,
        reason: "already-here",
        message: "Already here.",
      });
      continue;
    }
    const item: ResolvedMoveItem = {
      inventoryEntryId: row.entityId,
      targetLocationId,
    };
    if (move.quantity) item.quantity = move.quantity;
    items.push(item);
  }

  if (items.length === 0) {
    return { moved: 0, skipped, sideEffects: EMPTY_MUTATION_SIDE_EFFECTS };
  }

  const moved = await moveInventoryEntries(db, { items }, actor);
  await runMutationSideEffects(db, {
    action: "updated",
    entity: { entity: "location", id: targetLocationId },
    source: "inventory.resolveScanStrays",
  });

  return {
    moved: moved.length,
    skipped,
    sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
  };
}
