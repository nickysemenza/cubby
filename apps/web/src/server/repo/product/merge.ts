/**
 * Product merge — fold duplicate SKUs into one surviving Product.
 *
 * Duplicates are minted, not typed: `create_product` and the importers can each
 * land a row for the same physical thing under a different name/manufacturer
 * spelling, and `Product_name_manufacturer_key` only stops an *exact* repeat.
 * `findDuplicateProductIdentities` (repo/problems/detectors-product.ts) reports
 * them; this is how a human resolves one.
 *
 * ## Why this is harder than the other three merges
 *
 * Product has **eight** incoming edges, and five of them sit under a partial
 * unique index, so a blind re-point aborts the transaction rather than
 * producing a wrong answer:
 *
 *  | edge                          | index                          |
 *  |-------------------------------|--------------------------------|
 *  | `ProductExternalId.productId` | `(productId, source, kind)`    |
 *  | `InventoryEntry.productId`    | `(productId, locationId)`      |
 *  | `ProductImage.productId`      | `(productId, imageId)`         |
 *  | `ProjectToolUsage.productId`  | `(projectId, productId)`       |
 *  | `WishCandidate.productId`     | `(wishId, productId)`          |
 *
 * All five are planned through the shared `planSlotCollisions`; what happens to
 * an *absorbed* row is per-edge and deliberately not shared (see below). The
 * remaining three — `ProductUnitMappings`, `Expense`, `Task.subjectProductId` —
 * are plain re-points.
 *
 * ### The two rules worth writing down
 *
 * **External ids: the keeper's slot wins.** `(productId, source, kind)` is
 * single-valued identity — one Amazon ASIN, one McMaster part number. When both
 * products fill the same slot with *different* values (they cannot fill it with
 * the same value: the global `(source, kind, externalId)` unique index already
 * forbids two live rows sharing a triple), that is a genuine conflict, and the
 * keeper is the row the operator chose to keep, so its identifier stands. The
 * loser's row is soft-deleted and named in the audit entry rather than
 * vanishing — the same shape `foldChargeInto` uses for a discarded
 * `statedTotal`. A "richer row wins" rule was rejected: richness is not
 * evidence of correctness, and silently swapping a verified ASIN for a stale
 * one is the worse failure. The one thing that *is* carried is a `url` the
 * keeper's row lacks — fill-never-overwrite, the house rule from
 * `planVendorMerge` and `foldChargeInto`.
 *
 * Re-pointing can never violate the *global* `(source, kind, externalId)` index:
 * a re-point changes only `productId`, and two live rows can't already share the
 * triple. Only the per-product slot index needs planning.
 *
 * **Inventory: same-location entries are summed, not dropped.** Two products
 * stocked on the same shelf collide on `(productId, locationId)`. Doing this by
 * hand meant deleting the now-duplicate stock row, which silently discarded its
 * quantity; here the quantities add and the absorbed entry is soft-deleted (with
 * its own embedding cascade — `inventory` is searchable). Summing follows the
 * precedent in `inventory/bulk.ts`'s full-move collapse. Units that don't match
 * refuse the whole merge (`PRODUCT_MERGE_INVENTORY_UNIT_MISMATCH`) rather than
 * being converted: unit conversion is WASM's job and doesn't belong in a repo
 * transaction, and adding "2 box" to "3 each" is a data lie either way. The
 * preview surfaces it as a blocker so the refusal is visible before confirming.
 *
 * Every re-pointed inventory entry then re-values at the KEEPER's effective
 * price, so `syncInventoryValuationsForProduct` runs at the end — otherwise a
 * moved entry keeps a valuation derived from a product that no longer exists.
 */

import type { Amount } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import {
  type InventoryId,
  type ProductId,
  type ProductShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { MergeProductsInput } from "@cubby/schemas/product";
import { and, eq, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  expense,
  inventoryEntry,
  product,
  productExternalId,
  productImage,
  productUnitMappings,
  projectToolUsage,
  task,
  wishCandidate,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/repo/audit-log";
import {
  buildPartialUpdateValues,
  getDb,
  lockAndValidateForDelete,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding-cleanup";
import {
  countByTarget,
  impact,
  present,
  sideEffect,
} from "~/server/repo/impact";
import { syncInventoryValuationsForProduct } from "~/server/repo/inventory/crud";
import {
  finalizeMerge,
  planSlotCollisions,
  repointEdge,
  resolveMergeTargets,
} from "~/server/repo/merge";

export const PRODUCT_MERGE_EDGE_POLICY = {
  "ProductExternalId.productId": {
    code: "repoint-or-discard-conflicting-slot",
    effect: "move-dedupe",
    description:
      "A merged product's external ids move onto the survivor; one that would collide on a (source, kind) slot the survivor already fills is discarded and named in the audit trail.",
  },
  "ProductUnitMappings.productId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description:
      "A merged product's hand-entered unit conversions are re-pointed onto the survivor.",
  },
  "InventoryEntry.productId": {
    code: "repoint-or-sum-same-location",
    effect: "move-dedupe",
    description:
      "A merged product's stock moves onto the survivor; entries in a location the survivor already stocks are summed into the survivor's entry and the absorbed one is soft-deleted.",
  },
  "ProductImage.productId": {
    code: "move-dedupe-shared-image",
    effect: "move-dedupe",
    description:
      "A merged product's image associations move onto the survivor, skipping any image already attached to it.",
  },
  "Expense.productId": {
    code: "repoint-live-fk-with-audit",
    effect: "repoint",
    description:
      "A merged product's ledger lines are re-pointed onto the survivor, logged to the audit trail — net cost and the owned/sold window derive from them.",
  },
  "Task.subjectProductId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description:
      "Work history whose subject was a merged product re-points onto the survivor.",
  },
  "ProjectToolUsage.productId": {
    code: "repoint-or-drop-same-project",
    effect: "move-dedupe",
    description:
      "A merged product's project-use history moves onto the survivor, skipping projects the survivor is already recorded on.",
  },
  "WishCandidate.productId": {
    code: "repoint-or-drop-same-wish",
    effect: "move-dedupe",
    description:
      "A merged product's Wishlist candidacies move onto the survivor, skipping wishes the survivor is already a candidate for.",
  },
} as const satisfies IncomingEdgePolicy<"product", OperationDisposition>;

/**
 * Columns the survivor adopts from a merged-away product when — and only when —
 * its own value is null. Fill-never-overwrite, the same rule `foldChargeInto`
 * and `planVendorMerge` apply: the keeper is the record the operator chose, so
 * its values stand, and only its GAPS get filled.
 *
 * `upc` is in the list but is written LAST, after the losers are soft-deleted:
 * `Product_upc_key` is partial on `deletedAt IS NULL`, so adopting a live
 * loser's UPC would put two live rows on one code and abort the merge. Same
 * ordering trap `mergePurchases` hits with `(vendorId, orderId)`.
 */
const CARRIED_COLUMNS = [
  "upc",
  "fdc_id",
  "model",
  "price",
  "notes",
  "category",
  "ingredientId",
  "expectedQuantity",
] as const;
type CarriedColumn = (typeof CARRIED_COLUMNS)[number];

type ProductMergeRow = {
  id: ProductId;
  shortcode: string;
  name: string;
  aliases: string[];
  tags: string[];
} & { [K in CarriedColumn]: unknown };

interface ProductMergeSummary {
  /** The survivor, as a public shortcode. */
  keepId: ProductShortcode;
  /** The merged-away products. Their codes stay permanent tombstones. */
  deletedIds: ProductShortcode[];
  /**
   * Internal ids for the caller's own side-effect dispatch — never serialized
   * (a uuid must not reach a URL or an MCP payload). The merged-away rows are
   * soft-deleted by the time the caller runs, so their codes can no longer be
   * re-resolved; the same reason `MergeSummary` carries `deletedEntityIds`.
   */
  keepEntityId: ProductId;
  deletedEntityIds: ProductId[];
  externalIdsMoved: number;
  /** Loser identifier rows dropped because the keeper already filled the slot. */
  externalIdsDiscarded: number;
  inventoryMoved: number;
  /** Loser stock rows summed into a survivor entry in the same location. */
  inventoryMerged: number;
  expensesMoved: number;
  imagesMoved: number;
  unitMappingsMoved: number;
  tasksMoved: number;
  projectUsesMoved: number;
  wishCandidatesMoved: number;
  aliasesAdded: string[];
  /** Column names the survivor adopted from a merged-away product. */
  carriedFields: string[];
}

/** `(source, kind)` — the per-product identifier slot. */
const externalIdSlot = (row: { source: string; kind: string }) =>
  `${row.source}\u0000${row.kind}`;

type InventoryRow = {
  id: InventoryId;
  productId: ProductId;
  locationId: string;
  amount: Amount;
};

/**
 * The same-location fold, computed without writing so both the mutation and
 * `previewMergeProducts` run one implementation. Throws nothing — a unit
 * mismatch comes back as data, so the preview can report it as a blocker
 * instead of only surfacing after the mutation has been attempted.
 */
const planInventoryFold = (args: {
  keeperRows: InventoryRow[];
  loserRows: InventoryRow[];
}) => {
  const plan = planSlotCollisions({
    keeperRows: args.keeperRows,
    loserRows: args.loserRows,
    slotKey: (row) => row.locationId,
  });
  const mismatches = plan.absorb.filter(
    ({ row, into }) => row.amount.unit !== into.amount.unit,
  );
  return { ...plan, mismatches };
};

/**
 * Merge `mergeIds` into `keepId`.
 *
 * Re-points or folds all eight incoming edges (see the file doc for the two
 * collision rules), folds the losers' names/aliases/tags into the survivor,
 * fills the survivor's null columns from them, then soft-deletes them through
 * {@link finalizeMerge} — which is also what cascades their embeddings.
 */
export const mergeProducts = async (
  db: Database,
  input: MergeProductsInput,
  actor: ActorContext,
): Promise<ProductMergeSummary> => {
  const { keepId, loserIds } = await resolveMergeTargets(db, {
    entity: "product",
    keepId: input.keepId,
    mergeIds: input.mergeIds,
    notFound: "PRODUCT_NOT_FOUND",
    label: "Product",
    brand: (id) => unsafeProductId(id),
  });

  return await withTransaction(db, async (tx) => {
    // Lock every row first so a concurrent merge or delete can't interleave and
    // leave a unique index deciding the outcome.
    await lockAndValidateForDelete(
      tx,
      product,
      [keepId, ...loserIds],
      "Product",
    );

    const rows = (await tx.query.product.findMany({
      where: and(
        inArray(product.id, [keepId, ...loserIds]),
        notDeleted(product),
      ),
      columns: {
        id: true,
        shortcode: true,
        name: true,
        aliases: true,
        tags: true,
        upc: true,
        fdc_id: true,
        model: true,
        price: true,
        notes: true,
        category: true,
        ingredientId: true,
        expectedQuantity: true,
      },
    })) as unknown as ProductMergeRow[];
    const keeper = rows.find((row) => row.id === keepId);
    if (!keeper) {
      throw createAppError("PRODUCT_NOT_FOUND", `Product not found: ${keepId}`);
    }
    const losers = rows.filter((row) => row.id !== keepId);
    if (losers.length === 0) {
      return emptySummary(keeper.shortcode, keepId);
    }

    const now = new Date();
    const summary: ProductMergeSummary = emptySummary(keeper.shortcode, keepId);
    summary.deletedIds = losers.map((row) =>
      unsafeProductShortcode(row.shortcode),
    );
    summary.deletedEntityIds = losers.map((row) => row.id);

    // ---- InventoryEntry: refuse before writing anything --------------------
    const inventoryRows = (await tx.query.inventoryEntry.findMany({
      where: and(
        inArray(inventoryEntry.productId, [keepId, ...loserIds]),
        notDeleted(inventoryEntry),
      ),
      columns: { id: true, productId: true, locationId: true, amount: true },
    })) as InventoryRow[];
    const inventoryPlan = planInventoryFold({
      keeperRows: inventoryRows.filter((row) => row.productId === keepId),
      loserRows: inventoryRows.filter((row) => row.productId !== keepId),
    });
    if (inventoryPlan.mismatches.length > 0) {
      const detail = inventoryPlan.mismatches
        .map(({ row, into }) => `${row.amount.unit} vs ${into.amount.unit}`)
        .join(", ");
      throw createAppError(
        "PRODUCT_MERGE_INVENTORY_UNIT_MISMATCH",
        `Cannot merge products stocked in the same location under different units (${detail}). Convert one entry first.`,
      );
    }

    // ---- ProductExternalId -------------------------------------------------
    const externalIdRows = await tx.query.productExternalId.findMany({
      where: and(
        inArray(productExternalId.productId, [keepId, ...loserIds]),
        notDeleted(productExternalId),
      ),
      columns: {
        id: true,
        productId: true,
        source: true,
        kind: true,
        externalId: true,
        url: true,
      },
    });
    const externalIdPlan = planSlotCollisions({
      keeperRows: externalIdRows.filter((row) => row.productId === keepId),
      loserRows: externalIdRows.filter((row) => row.productId !== keepId),
      slotKey: externalIdSlot,
    });

    if (externalIdPlan.repoint.length > 0) {
      await tx
        .update(productExternalId)
        .set({ productId: keepId })
        .where(
          inArray(
            productExternalId.id,
            externalIdPlan.repoint.map((row) => row.id),
          ),
        );
      summary.externalIdsMoved = externalIdPlan.repoint.length;
    }
    const discardedExternalIds: string[] = [];
    for (const { row, into } of externalIdPlan.absorb) {
      // Fill-never-overwrite: a link the survivor's row lacks is worth keeping.
      if (into.url == null && row.url != null) {
        await tx
          .update(productExternalId)
          .set({ url: row.url })
          .where(eq(productExternalId.id, into.id));
      }
      await tx
        .update(productExternalId)
        .set({ deletedAt: now })
        .where(eq(productExternalId.id, row.id));
      discardedExternalIds.push(
        `${row.source}/${row.kind}=${row.externalId} (kept ${into.externalId})`,
      );
    }
    summary.externalIdsDiscarded = externalIdPlan.absorb.length;

    // ---- InventoryEntry: apply --------------------------------------------
    if (inventoryPlan.repoint.length > 0) {
      await tx
        .update(inventoryEntry)
        .set({ productId: keepId })
        .where(
          inArray(
            inventoryEntry.id,
            inventoryPlan.repoint.map((row) => row.id),
          ),
        );
      summary.inventoryMoved = inventoryPlan.repoint.length;
    }
    for (const { row, into } of inventoryPlan.absorb) {
      await tx
        .update(inventoryEntry)
        .set({
          amount: {
            ...into.amount,
            value: into.amount.value + row.amount.value,
          },
        })
        .where(eq(inventoryEntry.id, into.id));
      await tx
        .update(inventoryEntry)
        .set({ deletedAt: now })
        .where(eq(inventoryEntry.id, row.id));
      // Removal-path invariant: the absorbed stock row is a removal like any
      // other, so its embedding cascades with it (`inventory` is searchable).
      await softDeleteEntityEmbeddingsTx(tx, "inventory", [row.id]);
      await logAuditEntries(tx, actor, [
        {
          entityType: "inventory",
          entityId: into.id,
          action: "update",
          changes: {
            amount: {
              from: into.amount,
              to: {
                ...into.amount,
                value: into.amount.value + row.amount.value,
              },
            },
          },
        },
        { entityType: "inventory", entityId: row.id, action: "delete" },
      ]);
    }
    summary.inventoryMerged = inventoryPlan.absorb.length;

    // ---- ProductImage / ProjectToolUsage / WishCandidate -------------------
    // Three edges, one shape: re-point what fits, soft-delete the duplicate.
    // An absorbed row here carries no data the survivor's row doesn't already
    // have (the pair IS the row), so there is nothing to fold.
    summary.imagesMoved = await foldAssociation(tx, {
      table: productImage,
      rows: await tx.query.productImage.findMany({
        where: and(
          inArray(productImage.productId, [keepId, ...loserIds]),
          notDeleted(productImage),
        ),
        columns: { id: true, productId: true, imageId: true },
      }),
      keepId,
      slotKey: (row) => row.imageId,
      now,
    });
    summary.projectUsesMoved = await foldAssociation(tx, {
      table: projectToolUsage,
      rows: await tx.query.projectToolUsage.findMany({
        where: and(
          inArray(projectToolUsage.productId, [keepId, ...loserIds]),
          notDeleted(projectToolUsage),
        ),
        columns: { id: true, productId: true, projectId: true },
      }),
      keepId,
      slotKey: (row) => row.projectId,
      now,
    });
    summary.wishCandidatesMoved = await foldAssociation(tx, {
      table: wishCandidate,
      rows: await tx.query.wishCandidate.findMany({
        where: and(
          inArray(wishCandidate.productId, [keepId, ...loserIds]),
          notDeleted(wishCandidate),
        ),
        columns: { id: true, productId: true, wishId: true },
      }),
      keepId,
      slotKey: (row) => row.wishId,
      now,
    });

    // ---- Plain re-points ---------------------------------------------------
    summary.unitMappingsMoved = (
      await repointEdge(tx, "product", "ProductUnitMappings.productId", {
        from: loserIds,
        to: keepId,
        liveOnly: true,
      })
    ).length;
    summary.tasksMoved = (
      await repointEdge(tx, "product", "Task.subjectProductId", {
        from: loserIds,
        to: keepId,
        liveOnly: true,
      })
    ).length;
    // Money moving between products is an AUDITED change, exactly as it is on
    // `updateExpense` and in `foldChargeInto`'s purchaseId re-point — net cost
    // and the owned/sold window are derived from these rows.
    const movedExpenses = await repointEdge(
      tx,
      "product",
      "Expense.productId",
      {
        from: loserIds,
        to: keepId,
        liveOnly: true,
      },
    );
    summary.expensesMoved = movedExpenses.length;
    await logAuditEntries(
      tx,
      actor,
      movedExpenses.map((id) => ({
        entityType: "expense" as const,
        entityId: id,
        action: "update" as const,
        changes: { productId: { from: null, to: keepId } },
      })),
    );

    // ---- Survivor identity -------------------------------------------------
    const folded = uniq([
      ...keeper.aliases,
      ...losers.map((row) => row.name),
      ...losers.flatMap((row) => row.aliases ?? []),
    ]).filter((alias) => alias !== keeper.name);
    const existingAliases = new Set(keeper.aliases);
    summary.aliasesAdded = folded.filter(
      (alias) => !existingAliases.has(alias),
    );
    const tags = uniq([...keeper.tags, ...losers.flatMap((row) => row.tags)]);

    // `upc` is deliberately excluded here and written after the losers are
    // gone — see CARRIED_COLUMNS' note on the partial-unique index.
    const carried: Record<string, unknown> = {};
    for (const column of CARRIED_COLUMNS) {
      if (column === "upc") continue;
      if (keeper[column] != null) continue;
      const donor = losers.find((row) => row[column] != null);
      if (donor) carried[column] = donor[column];
    }
    summary.carriedFields = Object.keys(carried);

    await tx
      .update(product)
      .set({ aliases: folded, tags, ...buildPartialUpdateValues(carried) })
      .where(eq(product.id, keepId));

    // ---- Remove the losers -------------------------------------------------
    await finalizeMerge(tx, {
      entity: "product",
      table: product,
      keepId,
      loserIds,
      removal: "soft",
      actor,
      survivorChanges: {
        mergedFrom: { from: null, to: loserIds },
        ...(summary.carriedFields.length > 0
          ? { carriedOver: { from: null, to: carried } }
          : {}),
        ...(discardedExternalIds.length > 0
          ? { discardedExternalIds: { from: discardedExternalIds, to: null } }
          : {}),
      },
    });

    // Only now is the loser's UPC slot free — `Product_upc_key` is partial on
    // `deletedAt IS NULL`, so this must follow the soft-delete above.
    if (keeper.upc == null) {
      const donor = losers.find((row) => row.upc != null);
      if (donor) {
        await tx
          .update(product)
          .set({ upc: donor.upc as string })
          .where(eq(product.id, keepId));
        summary.carriedFields.push("upc");
      }
    }

    // Every moved entry now values at the KEEPER's effective price; without
    // this a re-pointed row keeps a valuation derived from a product that no
    // longer exists, and the location rollup silently reports the old number.
    await syncInventoryValuationsForProduct(tx, keepId);

    return summary;
  });
};

const emptySummary = (
  shortcode: string,
  keepEntityId: ProductId,
): ProductMergeSummary => ({
  keepId: unsafeProductShortcode(shortcode),
  deletedIds: [],
  keepEntityId,
  deletedEntityIds: [],
  externalIdsMoved: 0,
  externalIdsDiscarded: 0,
  inventoryMoved: 0,
  inventoryMerged: 0,
  expensesMoved: 0,
  imagesMoved: 0,
  unitMappingsMoved: 0,
  tasksMoved: 0,
  projectUsesMoved: 0,
  wishCandidatesMoved: 0,
  aliasesAdded: [],
  carriedFields: [],
});

/**
 * Re-point a pure association row (product↔image, product↔project,
 * product↔wish) onto the survivor, soft-deleting the ones whose pair the
 * survivor already has. Returns how many actually moved.
 *
 * These three share an implementation because they share a *shape*, not just a
 * plan: the row IS the pair, so an absorbed duplicate carries nothing to fold
 * into its survivor. External ids and inventory look similar and are handled
 * separately precisely because their absorbed rows do (a url; a quantity).
 */
const foldAssociation = async <
  Row extends { id: string; productId: ProductId },
>(
  tx: DrizzleTransaction,
  args: {
    // biome-ignore lint/suspicious/noExplicitAny: one helper over three structurally-identical join tables.
    table: any;
    rows: Row[];
    keepId: ProductId;
    slotKey: (row: Row) => string;
    now: Date;
  },
): Promise<number> => {
  const plan = planSlotCollisions({
    keeperRows: args.rows.filter((row) => row.productId === args.keepId),
    loserRows: args.rows.filter((row) => row.productId !== args.keepId),
    slotKey: args.slotKey,
  });
  if (plan.repoint.length > 0) {
    await tx
      .update(args.table)
      .set({ productId: args.keepId })
      .where(
        inArray(
          args.table.id,
          plan.repoint.map((row) => row.id),
        ),
      );
  }
  if (plan.absorb.length > 0) {
    await tx
      .update(args.table)
      .set({ deletedAt: args.now })
      .where(
        inArray(
          args.table.id,
          plan.absorb.map(({ row }) => row.id),
        ),
      );
  }
  return plan.repoint.length;
};

/**
 * What `mergeProducts` would do to the given products, without doing it.
 *
 * Reads the SAME `PRODUCT_MERGE_EDGE_POLICY` the mutation writes against, and
 * runs the SAME `planInventoryFold` — so the unit-mismatch refusal shows up as
 * a blocker the dialog can disable confirmation on, instead of only surfacing
 * as an error toast after the merge was attempted.
 *
 * Advisory only. `mergeProducts` re-plans everything inside its own
 * transaction; nothing here is a lock or a permission.
 */
export const previewMergeProducts = async (
  db: Database,
  input: { keepId: ProductId; mergeIds: ProductId[] },
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> => {
  const { keepId } = input;
  const losers = input.mergeIds.filter((id) => id !== keepId);
  if (losers.length === 0) {
    return { blockers: [], changes: [], sideEffects: [] };
  }
  const dbClient = getDb(db);

  const inventoryRows = (await dbClient.query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.productId, [keepId, ...losers]),
      notDeleted(inventoryEntry),
    ),
    columns: { id: true, productId: true, locationId: true, amount: true },
  })) as InventoryRow[];
  const inventoryPlan = planInventoryFold({
    keeperRows: inventoryRows.filter((row) => row.productId === keepId),
    loserRows: inventoryRows.filter((row) => row.productId !== keepId),
  });

  const byProduct = (rows: Array<{ productId: ProductId }>) => {
    const out: Record<string, number> = {};
    for (const row of rows) out[row.productId] = (out[row.productId] ?? 0) + 1;
    return out;
  };

  const blockers = present([
    impact({
      disposition: {
        code: "block-inventory-unit-mismatch",
        effect: "block",
        description:
          "Two entries in the same location carry different units, so their quantities can't be summed. Convert one first.",
      },
      edgeKey: "InventoryEntry.productId",
      label: "stock entries that can't be merged",
      byTargetId: byProduct(inventoryPlan.mismatches.map(({ row }) => row)),
    }),
  ]);

  const changes = present([
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["InventoryEntry.productId"],
      edgeKey: "InventoryEntry.productId",
      label: "stock entries moved",
      byTargetId: byProduct(inventoryPlan.repoint),
    }),
    impact({
      disposition: {
        code: "sum-same-location-stock",
        effect: "move-dedupe",
        description:
          "Stock in a location the survivor already stocks is summed into the survivor's entry and the absorbed entry is soft-deleted.",
      },
      edgeKey: "InventoryEntry.productId",
      label: "stock entries summed into the survivor",
      byTargetId: byProduct(inventoryPlan.absorb.map(({ row }) => row)),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["ProductExternalId.productId"],
      edgeKey: "ProductExternalId.productId",
      label: "external ids moved or discarded",
      byTargetId: await countByTarget(
        dbClient,
        productExternalId,
        productExternalId.productId,
        losers,
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["Expense.productId"],
      edgeKey: "Expense.productId",
      label: "ledger lines re-pointed",
      byTargetId: await countByTarget(
        dbClient,
        expense,
        expense.productId,
        losers,
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["ProductUnitMappings.productId"],
      edgeKey: "ProductUnitMappings.productId",
      label: "unit mappings re-pointed",
      byTargetId: await countByTarget(
        dbClient,
        productUnitMappings,
        productUnitMappings.productId,
        losers,
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["ProductImage.productId"],
      edgeKey: "ProductImage.productId",
      label: "image associations moved",
      byTargetId: await countByTarget(
        dbClient,
        productImage,
        productImage.productId,
        losers,
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["Task.subjectProductId"],
      edgeKey: "Task.subjectProductId",
      label: "tasks re-pointed",
      byTargetId: await countByTarget(
        dbClient,
        task,
        task.subjectProductId,
        losers,
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["ProjectToolUsage.productId"],
      edgeKey: "ProjectToolUsage.productId",
      label: "project uses moved",
      byTargetId: await countByTarget(
        dbClient,
        projectToolUsage,
        projectToolUsage.productId,
        losers,
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["WishCandidate.productId"],
      edgeKey: "WishCandidate.productId",
      label: "wishlist candidacies moved",
      byTargetId: await countByTarget(
        dbClient,
        wishCandidate,
        wishCandidate.productId,
        losers,
      ),
    }),
  ]);

  const sideEffects = [
    sideEffect({
      code: "resync-inventory-valuations",
      label: "stock entries re-valued",
      description:
        "Every entry that moves re-values at the surviving product's effective price.",
      total: inventoryPlan.repoint.length + inventoryPlan.absorb.length,
    }),
  ];

  return { blockers, changes, sideEffects };
};
