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
 * Product has **thirteen** declared incoming edges. Six association shapes sit
 * under a partial unique index, so a blind re-point aborts the transaction
 * rather than producing a wrong answer:
 *
 *  | edge                          | index                          |
 *  |-------------------------------|--------------------------------|
 *  | `ProductExternalId.productId` | `(productId, source, kind)`    |
 *  | `InventoryEntry.productId`    | `(productId, locationId, placement)` |
 *  | `ProductImage.productId`      | `(productId, imageId)`         |
 *  | `ProjectToolUsage.productId`  | `(projectId, productId)`       |
 *  | `PurchaseProduct.productId`   | `(purchaseId, productId)`      |
 *  | `WishCandidate.productId`     | `(wishId, productId)`          |
 *
 * All six are planned through the shared `planSlotCollisions`; what happens to
 * an *absorbed* row is per-edge and deliberately not shared (see below).
 * `ProductUnitMappings` is planned through it too, for a different reason — it
 * has NO unique index, so nothing would have refused a duplicate (see the fourth
 * rule). ProductComponent is the seventh slotted relationship and is treated
 * as a graph below. `Expense`, `Task.subjectProductId`, and `Location` are
 * plain re-points; conversion coverage is a rebuildable projection.
 *
 * ### The two rules worth writing down
 *
 * **External ids: the keeper's slot wins.** `(productId, source, kind)` is
 * single-valued identity — one Amazon ASIN, one McMaster part number. When both
 * products fill the same slot with *different* values (they cannot fill it with
 * the same value: the global `(source, kind, externalId)` unique index already
 * forbids two live rows sharing a triple), that is a genuine conflict, and the
 * keeper is the row the operator chose to keep, so its identifier stays
 * primary. The loser's row moves onto the survivor as a secondary identifier
 * and is named in the audit entry rather than vanishing. A "richer row wins"
 * rule was rejected: richness is not evidence of correctness, and silently
 * swapping a verified ASIN for a stale one is the worse failure. The one thing
 * that *is* carried is a `url` the keeper's row lacks —
 * fill-never-overwrite, the house rule from `planVendorMerge` and
 * `foldChargeInto`.
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
 *
 * ### The third rule: kit composition is a graph, not a slot
 *
 * `ProductComponent` points Product at Product, so a merge doesn't just move
 * rows between two disjoint sets — it **identifies two nodes of a DAG**, and
 * that can make a product contain itself. Both directions are real: merging a
 * kit into one of its own (possibly several-hops-down) components, and merging
 * a component into the kit that lists it. The DB CHECK
 * `ProductComponent_not_self_check` only refuses the one-hop case; the
 * multi-hop one is a reachability question, answered here by
 * {@link findMergeComponentCycle} over the WHOLE projected post-merge edge set.
 * Two individually-acyclic products can produce a cycle once their edge sets
 * are unioned, so checking only the touched edge is not enough.
 *
 * On top of that, `(parentProductId, componentProductId)` is another partial
 * unique slot, and the two directions want *opposite* fold rules:
 *
 *  - **Two kits merging, both listing the same part.** Same quantity → dedupe;
 *    different quantities → refuse the whole merge
 *    (`PRODUCT_MERGE_COMPONENT_QUANTITY_MISMATCH`). Only one row can survive
 *    the index, and silently keeping either number invents or destroys units of
 *    a real part. Same refusal shape as the inventory unit mismatch, and for
 *    the same reason: there is no honest answer, so the operator picks one
 *    first.
 *  - **Two components merging, both listed in one kit.** Quantities **sum**.
 *    Two rows saying "this kit holds 2 of A" and "this kit holds 3 of B", once
 *    A and B are established to be the same part, say the kit holds 5 of it —
 *    the identical argument that makes same-location stock sum rather than
 *    collapse.
 *
 * ### The fourth rule: conversion edges dedupe, and the keeper's ratio wins
 *
 * `ProductUnitMappings` is the one slotted edge with **no unique index**, so it
 * is here for meaning rather than for index safety: nothing in the database
 * would have refused the duplicate, and before this fold a merge simply
 * accumulated both rows. Merging two olive oils that each stated a density left
 * the survivor holding `1 ml = 0.9 g` AND `1 ml = 0.92 g` — one product, two
 * answers, and which one a valuation used came down to row order.
 *
 * That failure was invisible from every direction: the write said nothing, the
 * preview reported a plain re-point, and `detect_unit_mapping_islands` — the
 * detector that watches this area — fires when a graph splits into 2+ islands,
 * i.e. on too FEW connections. A redundant edge adds a connection, so a bad
 * merge made the graph look healthier and the alarm quieter.
 *
 * The slot is the unordered unit pair, so `1 ml = 0.92 g` and `1 g = 1.087 ml`
 * collide. Within a slot:
 *
 *  - **Ratios agree** → the loser's row is a true duplicate. Soft-deleted
 *    silently and counted in `unitMappingsDeduped`; reporting it as data loss
 *    would be a lie.
 *  - **Ratios disagree** → the keeper's edge stands and the loser's is
 *    soft-deleted and named in `unitMappingsDiscarded` + the audit entry. This
 *    follows the external-id rule ("the keeper is the row the operator chose")
 *    rather than the inventory/kit rule of refusing outright, because dropping
 *    a conversion edge destroys no units — the survivor is left with a
 *    complete, self-consistent graph, which is precisely what keeping both
 *    denies it.
 */

import type { Amount } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import type { ExternalIdKind } from "@cubby/schemas/external-id";
import {
  type InventoryId,
  type ProductId,
  type ProductShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { InventoryPlacement } from "@cubby/schemas/inventory";
import { isbnFromGtin } from "@cubby/schemas/isbn";
import type { MergeProductsInput } from "@cubby/schemas/product";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { sumBy, uniq } from "es-toolkit";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  cookbook,
  expense,
  inventoryEntry,
  location,
  product,
  productComponent,
  productConversionCoverage,
  productExternalId,
  productImage,
  productUnitMappings,
  projectToolUsage,
  purchaseProduct,
  task,
  wishCandidate,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { type AuditEntryInput, logAuditEntries } from "~/server/repo/audit-log";
import {
  buildPartialUpdateValues,
  getDb,
  lockAndValidateForDelete,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { impact, present, sideEffect } from "~/server/repo/impact";
import { syncInventoryValuationsForProduct } from "~/server/repo/inventory/crud";
import {
  assertDistinctMergeTargets,
  finalizeMerge,
  foldAssociation,
  planSlotCollisions,
  resolveMergeTargets,
  type SlotCollisionPlan,
} from "~/server/repo/merge";
import { cascadeRemoval } from "~/server/repo/removal";
import { markProductConversionCoverageInputStale } from "./conversion-coverage";
import { ensureSlotPrimaries } from "./update-helpers";

export const PRODUCT_MERGE_EDGE_POLICY = {
  "ProductExternalId.productId": {
    code: "repoint-or-discard-conflicting-slot",
    effect: "move-dedupe",
    description:
      "A merged product's external ids move onto the survivor; one that would collide on a (source, kind) slot the survivor already fills is discarded and named in the audit trail.",
  },
  "ProductUnitMappings.productId": {
    code: "repoint-or-discard-conflicting-conversion",
    effect: "move-dedupe",
    description:
      "A merged product's hand-entered unit conversions move onto the survivor; one stating a unit pair the survivor already states is dropped — silently when the ratio agrees, and named in the audit trail when it disagrees.",
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
  "PurchaseProduct.productId": {
    code: "repoint-or-drop-same-purchase",
    effect: "move-dedupe",
    description:
      "A merged product's purchase links move onto the survivor, skipping orders the survivor is already recorded against.",
  },
  "WishCandidate.productId": {
    code: "repoint-or-drop-same-wish",
    effect: "move-dedupe",
    description:
      "A merged product's Wishlist candidacies move onto the survivor, skipping wishes the survivor is already a candidate for.",
  },
  "Location.productId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description:
      "Locations that ARE a merged product re-point onto the survivor. A plain repoint, not a fold: many locations legitimately share one SKU (twelve bins can all be the same tote), so there is no slot to collide on.",
  },
  "ProductComponent.parentProductId": {
    code: "repoint-or-dedupe-identical-component",
    effect: "move-dedupe",
    description:
      "A merged kit's own component list moves onto the survivor; a part both kits list at the SAME quantity is deduped, and one they list at different quantities refuses the merge rather than inventing or destroying units.",
  },
  "ProductComponent.componentProductId": {
    code: "repoint-or-sum-same-kit",
    effect: "move-dedupe",
    description:
      "Kits that listed a merged product as a part now list the survivor; where one kit listed both, the two quantities are summed into the survivor's row and the absorbed one is soft-deleted.",
  },
  "Cookbook.productId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description:
      "A Cookbook whose physical copy was merged away re-points onto the survivor, the same plain repoint as a Location. Nothing dedupes: a survivor claimed by two cookbooks is odd but not destructive, and refusing the merge over it would be worse than letting the operator unlink one.",
  },
  "ProductConversionCoverage.productId": {
    code: "discard-rebuildable-projection",
    effect: "hard-delete",
    description:
      "Absorbed products' conversion projections are discarded; the survivor is marked stale and rebuilt from the merged graph.",
  },
} as const satisfies IncomingEdgePolicy<"product", OperationDisposition>;

/**
 * Columns the survivor adopts from a merged-away product when — and only when —
 * its own value is null. Fill-never-overwrite, the same rule `foldChargeInto`
 * and `planVendorMerge` apply: the keeper is the record the operator chose, so
 * its values stand, and only its GAPS get filled.
 *
 * Barcodes are NOT here and must not be: a product carries a set of them, and
 * folding a set into a "fill the keeper's null" rule is what made every merge
 * of two barcoded products destroy one. They ride the external-id fold instead,
 * where the loser's `gtin` row survives as a demoted secondary.
 */
const CARRIED_COLUMNS = [
  "fdc_id",
  "model",
  "price",
  "notes",
  "category",
  "ingredientId",
  "expectedQuantity",
  // Nullable on purpose (`presenceFilter` exposes "undecided" as a real
  // state), so a deliberate `false` on a merged-away kit is a value the
  // survivor's null slot should adopt — not a default to be re-derived.
  "stockTracked",
] as const;
type CarriedColumn = (typeof CARRIED_COLUMNS)[number];

const CARRIED_FIELD_LABELS: Record<CarriedColumn, string> = {
  fdc_id: "USDA food identity",
  model: "model",
  price: "price",
  notes: "notes",
  category: "category",
  ingredientId: "linked ingredient",
  expectedQuantity: "expected quantity",
  stockTracked: "stock-tracking decision",
};

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
  /** Rows `finalizeMerge` actually soft-deleted — measured, not `mergeIds.length`. */
  merged: number;
  /**
   * Internal ids for the caller's own side-effect dispatch — never serialized
   * (a uuid must not reach a URL or an MCP payload). The merged-away rows are
   * soft-deleted by the time the caller runs, so their codes can no longer be
   * re-resolved; the same reason `MergeSummary` carries `deletedEntityIds`.
   */
  keepEntityId: ProductId;
  deletedEntityIds: ProductId[];
  externalIdsMoved: number;
  /**
   * Loser identifiers whose slot the keeper already filled, kept as SECONDARY
   * rows on the survivor rather than destroyed.
   *
   * Each one is a real listing — Amazon lists one item twice — so discarding it
   * meant the next order line quoting it re-minted the duplicate the merge had
   * just removed. That happened three times in one import session.
   */
  externalIdsDemoted: Array<{
    source: string;
    kind: ExternalIdKind;
    externalId: string;
  }>;

  inventoryMoved: number;
  /** Loser stock rows summed into a survivor entry in the same location. */
  inventoryMerged: number;
  expensesMoved: number;
  imagesMoved: number;
  unitMappingsMoved: number;
  /**
   * Loser conversion edges dropped because the survivor already stated the same
   * pair at the same ratio. A true duplicate — nothing was lost.
   */
  unitMappingsDeduped: number;
  /**
   * Loser conversion edges dropped because the survivor already answered that
   * unit pair DIFFERENTLY.
   *
   * Keeping both is the actual hazard: two live densities for one product make
   * every valuation that routes through them depend on row order, and the
   * island detector can't see it — a redundant edge makes the graph look MORE
   * connected, so the one signal watching this area gets quieter, not louder.
   */
  unitMappingsDiscarded: Array<{
    from: string;
    to: string;
    keptRatio: number | null;
    discardedRatio: number | null;
    source: string | null;
  }>;
  tasksMoved: number;
  /** Locations that ARE a merged-away product, re-pointed onto the survivor. */
  locationsMoved: number;
  /** Cookbooks whose physical copy was merged away, re-pointed onto the survivor. */
  cookbooksMoved: number;
  projectUsesMoved: number;
  purchaseLinksMoved: number;
  wishCandidatesMoved: number;
  /** Rows on a merged-away KIT's component list, re-pointed onto the survivor. */
  componentsMoved: number;
  /** Component rows dropped because the survivor already listed that part at the same quantity. */
  componentsDeduped: number;
  /** Rows where a merged-away product was the PART, re-pointed onto the survivor. */
  kitLinksMoved: number;
  /** Rows summed into the survivor's row because one kit listed two merged parts. */
  kitLinksSummed: number;
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
  placement: InventoryPlacement;
  amount: Amount;
};

/** `(locationId, placement)` — the shelf slot two rows must share to fold. */
const inventorySlot = (row: { locationId: string; placement: string }) =>
  `${row.locationId}\u0000${row.placement}`;

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
  // Keyed by placement as well as location: the loser's spare on the shelf and
  // the keeper's unit wired into the wall are the same product in the same room
  // and still must not fold into one another.
  const plan = planSlotCollisions({
    keeperRows: args.keeperRows,
    loserRows: args.loserRows,
    slotKey: inventorySlot,
  });
  const mismatches = plan.absorb.flatMap(({ into, rows }) =>
    rows
      .filter((row) => row.amount.unit !== into.amount.unit)
      .map((row) => ({ row, into })),
  );
  return { ...plan, mismatches };
};

/** One live `ProductUnitMappings` row: one conversion edge and where it came from. */
type UnitMappingRow = {
  id: string;
  productId: ProductId;
  a: Amount;
  b: Amount;
  source: string | null;
};

/**
 * The unordered unit pair — `1 ml = 0.92 g` and `1 g = 1.087 ml` are the same
 * edge stated in opposite directions, so they share a slot.
 *
 * Matching is LITERAL (trimmed + lowercased), not semantic: `ml↔g` and `L↔g`
 * are a real conflict this key deliberately does not see. Resolving that needs
 * the conversion kernel, and unit conversion does not belong in a repo
 * transaction — the same rule that makes a colliding inventory unit refuse the
 * merge rather than convert. Cross-scale contradictions stay the projection
 * lane's job; the merge already marks `ProductConversionCoverage` stale, so the
 * rebuild re-evaluates the merged graph outside this transaction. Do not
 * "improve" this by importing WASM here.
 */
const unitMappingSlot = (row: { a: Amount; b: Amount }) => {
  const x = row.a.unit.trim().toLowerCase();
  const y = row.b.unit.trim().toLowerCase();
  return x <= y ? `${x}\u0000${y}` : `${y}\u0000${x}`;
};

/**
 * How much of the edge's OTHER unit sits on one `fromUnit` — so a caller picks
 * the direction rather than inheriting whichever way the row happened to be
 * entered.
 *
 * `null` for a degenerate row (a zero or non-finite side) or a unit this edge
 * doesn't mention. A degenerate row can never be shown equal to anything, so it
 * is treated as conflicting and reported rather than silently deduped away.
 */
const ratioPerUnit = (
  row: { a: Amount; b: Amount },
  fromUnit: string,
): number | null => {
  const target = fromUnit.trim().toLowerCase();
  const [from, to] =
    row.a.unit.trim().toLowerCase() === target
      ? [row.a, row.b]
      : row.b.unit.trim().toLowerCase() === target
        ? [row.b, row.a]
        : [null, null];
  if (from === null || to === null || from.value === 0) return null;
  const ratio = to.value / from.value;
  return Number.isFinite(ratio) ? ratio : null;
};

/**
 * The edge's ratio in one canonical direction — per 1 of the lexicographically
 * earlier unit — so two rows in a slot compare regardless of which way round
 * each was entered.
 *
 * FOR COMPARISON ONLY. It is not the number to report: the canonical direction
 * is chosen by string order, so `1 ml = 0.92 g` canonicalizes to 1.087 (ml per
 * gram, since "g" < "ml"). Printing that beside a `from: ml, to: g` label reads
 * as the reciprocal of what the row says — caught by the integration test that
 * asserted 0.92 and got 1.087. Report with {@link ratioPerUnit} in the row's own
 * direction instead.
 */
const unitMappingRatio = (row: { a: Amount; b: Amount }): number | null => {
  const x = row.a.unit.trim().toLowerCase();
  const y = row.b.unit.trim().toLowerCase();
  return ratioPerUnit(row, x <= y ? x : y);
};

/** Two ratios agree to within double-precision noise, compared relatively. */
const sameRatio = (left: number | null, right: number | null): boolean =>
  left !== null &&
  right !== null &&
  Math.abs(left - right) <= 1e-9 * Math.max(Math.abs(left), Math.abs(right), 1);

/**
 * The conversion-edge fold, computed without writing so the mutation and
 * `previewMergeProducts` run one implementation — the same reason
 * `planInventoryFold` exists.
 *
 * Note there is NO unique index on `ProductUnitMappings`, so unlike every other
 * slotted edge here nothing in the database would have refused the duplicate:
 * before this fold a merge simply accumulated both edges, and the survivor
 * quietly held two contradictory answers for one conversion.
 */
export const planUnitMappingFold = (args: {
  keeperRows: UnitMappingRow[];
  loserRows: UnitMappingRow[];
}) => {
  const plan = planSlotCollisions({
    keeperRows: args.keeperRows,
    loserRows: args.loserRows,
    slotKey: unitMappingSlot,
  });
  const absorbed = plan.absorb.flatMap(({ into, rows }) =>
    rows.map((row) => ({
      row,
      into,
      // Same pair AND same ratio is a true duplicate — dropping it loses
      // nothing and must not be reported as data loss. A different ratio is a
      // contradiction, and the keeper's edge is the one the operator chose.
      redundant: sameRatio(unitMappingRatio(row), unitMappingRatio(into)),
    })),
  );
  return { ...plan, absorbed };
};

/** One live `ProductComponent` row: a kit, one part it contains, how many. */
interface ComponentRow {
  id: string;
  parentProductId: ProductId;
  componentProductId: ProductId;
  quantity: number;
}

/**
 * Would merging `loserIds` into `keepId` make some product contain itself?
 *
 * Pure, and deliberately so — the whole question is decidable from the edge
 * set, so it is unit-tested directly rather than only through a real merge.
 *
 * **The projection.** A merge identifies nodes: every occurrence of a loser id,
 * on either end of an edge, becomes `keepId`. The check runs over that whole
 * projected edge set, not just the edges the merge happens to re-point — a kit
 * two hops above the survivor and a part two hops below it are individually
 * fine and close a loop the moment the two nodes become one.
 *
 * **Why searching from the survivor is exhaustive.** Any cycle in the projected
 * graph that does *not* pass through `keepId` consists entirely of edges whose
 * endpoints the projection left alone, so it already existed and the merge did
 * not cause it. Every cycle the merge *creates* therefore contains `keepId`,
 * which makes "does the survivor reach itself" the exact question — and one
 * ordinary traversal answers it, rather than a full-graph SCC pass.
 *
 * **Termination.** `seen` admits each node once, so a pre-existing corrupt
 * cycle anywhere downstream is walked into and then dropped instead of spun on.
 * That does not cost completeness: this asks whether *some* reachable node has
 * an edge back to `keepId`, and that edge is examined when the node is expanded
 * regardless of which path first reached it. O(V + E) over the reachable
 * projected subgraph, one visit per node, one look per edge.
 *
 * Returns the offending cycle as a closed path (`[keepId, …, keepId]`, in
 * post-merge ids), or null when the merge is safe.
 */
export const findMergeComponentCycle = (args: {
  edges: readonly {
    parentProductId: ProductId;
    componentProductId: ProductId;
  }[];
  keepId: ProductId;
  loserIds: readonly ProductId[];
}): ProductId[] | null => {
  const merged = new Set<ProductId>(args.loserIds);
  const project = (id: ProductId): ProductId =>
    merged.has(id) ? args.keepId : id;

  const children = new Map<ProductId, ProductId[]>();
  for (const edge of args.edges) {
    const parent = project(edge.parentProductId);
    const child = project(edge.componentProductId);
    const bucket = children.get(parent);
    if (bucket) bucket.push(child);
    else children.set(parent, [child]);
  }

  const cameFrom = new Map<ProductId, ProductId>();
  const seen = new Set<ProductId>([args.keepId]);
  const stack: ProductId[] = [args.keepId];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const child of children.get(node) ?? []) {
      if (child === args.keepId) {
        const path: ProductId[] = [];
        let at: ProductId | undefined = node;
        while (at !== undefined && at !== args.keepId) {
          path.push(at);
          at = cameFrom.get(at);
        }
        path.push(args.keepId);
        path.reverse();
        return [...path, args.keepId];
      }
      if (seen.has(child)) continue;
      seen.add(child);
      cameFrom.set(child, node);
      stack.push(child);
    }
  }
  return null;
};

interface ComponentMergePlan {
  /** Non-null when the merge would make a product contain itself. */
  cycle: ProductId[] | null;
  /** Rows where a LOSER is the kit — its component list moving to the survivor. */
  kit: {
    repoint: ComponentRow[];
    /** Same part, same quantity, already on the survivor's list — drop. */
    dedupe: ComponentRow[];
    /** Same part, DIFFERENT quantity — the merge must refuse. */
    conflicts: Array<{ into: ComponentRow; rows: ComponentRow[] }>;
  };
  /** Rows where a LOSER is the part — kits that listed it now list the survivor. */
  part: {
    repoint: ComponentRow[];
    /** One kit listed two merged parts; the quantities sum into `into`. */
    absorb: Array<{ into: ComponentRow; rows: ComponentRow[] }>;
  };
}

/**
 * The whole `ProductComponent` consequence of a merge, computed without
 * writing, so `mergeProducts` and `previewMergeProducts` share one
 * implementation of the rules rather than two readings of them. Throws
 * nothing: both refusals come back as data (`cycle`, `kit.conflicts`) so the
 * preview can report them as blockers before anything destructive is confirmed.
 *
 * `rows` is every LIVE component row, not just the touched ones — {@link
 * findMergeComponentCycle} needs the global edge set, and the fold plans simply
 * ignore rows that name no merged product.
 */
export const planProductComponentMerge = (args: {
  keepId: ProductId;
  loserIds: readonly ProductId[];
  rows: readonly ComponentRow[];
}): ComponentMergePlan => {
  const cycle = findMergeComponentCycle({
    edges: args.rows,
    keepId: args.keepId,
    loserIds: args.loserIds,
  });

  const merged = new Set<ProductId>(args.loserIds);
  const inMergeSet = (id: ProductId) => id === args.keepId || merged.has(id);
  // A row with BOTH ends inside the merge set folds to a self-edge — which is
  // exactly the cycle reported above, and the reason the merge is about to be
  // refused. Dropping it here keeps the two fold plans over disjoint rows so a
  // preview can still describe everything else that would have happened.
  const rows = args.rows.filter(
    (row) =>
      !(inMergeSet(row.parentProductId) && inMergeSet(row.componentProductId)),
  );

  const kitPlan = planSlotCollisions({
    keeperRows: rows.filter((row) => row.parentProductId === args.keepId),
    loserRows: rows.filter((row) => merged.has(row.parentProductId)),
    slotKey: (row) => row.componentProductId,
  });
  const sameQuantity = (group: { into: ComponentRow; rows: ComponentRow[] }) =>
    group.rows.every((row) => row.quantity === group.into.quantity);

  const partPlan = planSlotCollisions({
    keeperRows: rows.filter((row) => row.componentProductId === args.keepId),
    loserRows: rows.filter((row) => merged.has(row.componentProductId)),
    slotKey: (row) => row.parentProductId,
  });

  return {
    cycle,
    kit: {
      repoint: kitPlan.repoint,
      dedupe: kitPlan.absorb.filter(sameQuantity).flatMap(({ rows }) => rows),
      conflicts: kitPlan.absorb.filter((group) => !sameQuantity(group)),
    },
    part: partPlan,
  };
};

/** Every live component row. See {@link planProductComponentMerge} on why all of them. */
const loadComponentRows = async (
  db: DrizzleClient | DrizzleTransaction,
): Promise<ComponentRow[]> =>
  await db.query.productComponent.findMany({
    where: notDeleted(productComponent),
    columns: {
      id: true,
      parentProductId: true,
      componentProductId: true,
      quantity: true,
    },
  });

/** Render an id path as shortcodes — a uuid must never reach a client message. */
const describeProductPath = async (
  db: DrizzleClient | DrizzleTransaction,
  path: readonly ProductId[],
): Promise<string> => {
  const rows = await db
    .select({ id: product.id, shortcode: product.shortcode })
    .from(product)
    .where(inArray(product.id, uniq([...path])));
  const byId = new Map(rows.map((row) => [row.id, row.shortcode]));
  return path.map((id) => byId.get(id) ?? "?").join(" → ");
};

type ExternalIdRow = {
  id: string;
  productId: ProductId;
  source: string;
  kind: string;
  externalId: string;
  url: string | null;
  isPrimary: boolean;
};

const distinctIsbns = (rows: readonly ExternalIdRow[]): string[] =>
  uniq(
    rows.flatMap((row) => {
      if (row.source !== "gtin") return [];
      const isbn = isbnFromGtin(row.externalId);
      return isbn ? [isbn.isbn13] : [];
    }),
  );

type ProductAssociationRow = {
  id: string;
  productId: ProductId;
};

type ProductImageAssociationRow = ProductAssociationRow & {
  imageId: string;
  sortOrder: number;
  createdAt: Date;
};

type ProjectUseAssociationRow = ProductAssociationRow & { projectId: string };
type PurchaseAssociationRow = ProductAssociationRow & { purchaseId: string };
type WishAssociationRow = ProductAssociationRow & { wishId: string };

interface PlannedAssociation<Row extends ProductAssociationRow> {
  rows: Row[];
  collision: SlotCollisionPlan<Row>;
}

interface ProductMergePlan {
  loserIds: ProductId[];
  keeper: ProductMergeRow;
  losers: ProductMergeRow[];
  inventory: ReturnType<typeof planInventoryFold> & { rows: InventoryRow[] };
  components: ComponentMergePlan;
  unitMappings: ReturnType<typeof planUnitMappingFold>;
  externalIds: {
    rows: ExternalIdRow[];
    collision: SlotCollisionPlan<ExternalIdRow>;
  };
  images: PlannedAssociation<ProductImageAssociationRow>;
  projectUses: PlannedAssociation<ProjectUseAssociationRow>;
  purchases: PlannedAssociation<PurchaseAssociationRow>;
  wishes: PlannedAssociation<WishAssociationRow>;
  expenses: ProductAssociationRow[];
  tasks: ProductAssociationRow[];
  locations: ProductAssociationRow[];
  cookbooks: ProductAssociationRow[];
  conversionCoverage: ProductAssociationRow[];
  survivorImageIds: string[];
  aliases: string[];
  aliasesAdded: string[];
  tags: string[];
  carried: Record<string, unknown>;
}

const planAssociation = <Row extends ProductAssociationRow>(args: {
  rows: Row[];
  keepId: ProductId;
  slotKey: (row: Row) => string;
}): PlannedAssociation<Row> => ({
  rows: args.rows,
  collision: planSlotCollisions({
    keeperRows: args.rows.filter((row) => row.productId === args.keepId),
    loserRows: args.rows.filter((row) => row.productId !== args.keepId),
    slotKey: args.slotKey,
  }),
});

/**
 * Load and decide every Product-merge consequence without writing.
 *
 * This is the Product merge module's single deep interface. Advisory preview
 * presents this plan; mutation rebuilds it after locking the products inside
 * its transaction and executes these exact decisions. UUIDs remain internal to
 * the module and are translated to shortcodes by the operation-preview router.
 */
async function buildProductMergePlan(
  db: DrizzleClient | DrizzleTransaction,
  input: { keepId: ProductId; loserIds: ProductId[] },
): Promise<ProductMergePlan>;
async function buildProductMergePlan(
  db: DrizzleClient | DrizzleTransaction,
  input: { keepId: ProductId; loserIds: ProductId[] },
  options: { allowMissingKeeper: true },
): Promise<ProductMergePlan | null>;
async function buildProductMergePlan(
  db: DrizzleClient | DrizzleTransaction,
  input: { keepId: ProductId; loserIds: ProductId[] },
  options?: { allowMissingKeeper?: boolean },
): Promise<ProductMergePlan | null> {
  const requestedIds = [input.keepId, ...input.loserIds];
  // Deliberately sequential: this function also runs on one transaction
  // client, and pg deprecates submitting another query while that client is
  // already executing one.
  const productRows = (await db.query.product.findMany({
    where: and(inArray(product.id, requestedIds), notDeleted(product)),
    columns: {
      id: true,
      shortcode: true,
      name: true,
      aliases: true,
      tags: true,
      fdc_id: true,
      model: true,
      price: true,
      notes: true,
      category: true,
      ingredientId: true,
      expectedQuantity: true,
      stockTracked: true,
    },
  })) as ProductMergeRow[];
  const keeper = productRows.find((row) => row.id === input.keepId);
  if (!keeper) {
    if (options?.allowMissingKeeper) return null;
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      `Product not found: ${input.keepId}`,
    );
  }
  const productById = new Map(productRows.map((row) => [row.id, row]));
  const losers = uniq(input.loserIds).flatMap((id) => {
    const row = productById.get(id);
    return row && row.id !== input.keepId ? [row] : [];
  });
  const liveLoserIds = losers.map((row) => row.id);
  const ids = [input.keepId, ...liveLoserIds];
  const inventoryRows = (await db.query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.productId, ids),
      notDeleted(inventoryEntry),
    ),
    columns: {
      id: true,
      productId: true,
      locationId: true,
      placement: true,
      amount: true,
    },
  })) as InventoryRow[];
  const componentRows = await loadComponentRows(db);
  const unitMappingRows = (await db.query.productUnitMappings.findMany({
    where: and(
      inArray(productUnitMappings.productId, ids),
      notDeleted(productUnitMappings),
    ),
    columns: { id: true, productId: true, a: true, b: true, source: true },
    orderBy: [asc(productUnitMappings.createdAt), asc(productUnitMappings.id)],
  })) as UnitMappingRow[];
  const externalIdRows = (await db.query.productExternalId.findMany({
    where: and(
      inArray(productExternalId.productId, ids),
      notDeleted(productExternalId),
    ),
    columns: {
      id: true,
      productId: true,
      source: true,
      kind: true,
      externalId: true,
      url: true,
      isPrimary: true,
    },
    orderBy: [
      desc(productExternalId.isPrimary),
      asc(productExternalId.createdAt),
      asc(productExternalId.id),
    ],
  })) as ExternalIdRow[];
  const imageRows = (await db.query.productImage.findMany({
    where: and(inArray(productImage.productId, ids), notDeleted(productImage)),
    columns: {
      id: true,
      productId: true,
      imageId: true,
      sortOrder: true,
      createdAt: true,
    },
    orderBy: [asc(productImage.sortOrder), asc(productImage.createdAt)],
  })) as ProductImageAssociationRow[];
  const projectUseRows = (await db.query.projectToolUsage.findMany({
    where: and(
      inArray(projectToolUsage.productId, ids),
      notDeleted(projectToolUsage),
    ),
    columns: { id: true, productId: true, projectId: true },
  })) as ProjectUseAssociationRow[];
  const purchaseRows = (await db.query.purchaseProduct.findMany({
    where: and(
      inArray(purchaseProduct.productId, ids),
      notDeleted(purchaseProduct),
    ),
    columns: { id: true, productId: true, purchaseId: true },
  })) as PurchaseAssociationRow[];
  const wishRows = (await db.query.wishCandidate.findMany({
    where: and(
      inArray(wishCandidate.productId, ids),
      notDeleted(wishCandidate),
    ),
    columns: { id: true, productId: true, wishId: true },
  })) as WishAssociationRow[];
  const expenses = (await db
    .select({ id: expense.id, productId: expense.productId })
    .from(expense)
    .where(
      and(inArray(expense.productId, liveLoserIds), notDeleted(expense)),
    )) as ProductAssociationRow[];
  const tasks = (await db
    .select({ id: task.id, productId: task.subjectProductId })
    .from(task)
    .where(
      and(inArray(task.subjectProductId, liveLoserIds), notDeleted(task)),
    )) as ProductAssociationRow[];
  const locations = (await db
    .select({ id: location.id, productId: location.productId })
    .from(location)
    .where(
      and(inArray(location.productId, liveLoserIds), notDeleted(location)),
    )) as ProductAssociationRow[];
  const cookbooks = (await db
    .select({ id: cookbook.id, productId: cookbook.productId })
    .from(cookbook)
    .where(
      and(inArray(cookbook.productId, liveLoserIds), notDeleted(cookbook)),
    )) as ProductAssociationRow[];
  const conversionCoverage = (await db
    .select({
      id: productConversionCoverage.productId,
      productId: productConversionCoverage.productId,
    })
    .from(productConversionCoverage)
    .where(
      inArray(productConversionCoverage.productId, liveLoserIds),
    )) as ProductAssociationRow[];
  const aliases = uniq([
    ...keeper.aliases,
    ...losers.map((row) => row.name),
    ...losers.flatMap((row) => row.aliases ?? []),
  ]).filter((alias) => alias !== keeper.name);
  const existingAliases = new Set(keeper.aliases);
  const carried: Record<string, unknown> = {};
  for (const column of CARRIED_COLUMNS) {
    if (keeper[column] != null) continue;
    const donor = losers.find((row) => row[column] != null);
    if (donor) carried[column] = donor[column];
  }

  return {
    loserIds: liveLoserIds,
    keeper,
    losers,
    inventory: {
      rows: inventoryRows,
      ...planInventoryFold({
        keeperRows: inventoryRows.filter(
          (row) => row.productId === input.keepId,
        ),
        loserRows: inventoryRows.filter(
          (row) => row.productId !== input.keepId,
        ),
      }),
    },
    components: planProductComponentMerge({
      keepId: input.keepId,
      loserIds: liveLoserIds,
      rows: componentRows,
    }),
    unitMappings: planUnitMappingFold({
      keeperRows: unitMappingRows.filter(
        (row) => row.productId === input.keepId,
      ),
      loserRows: unitMappingRows.filter(
        (row) => row.productId !== input.keepId,
      ),
    }),
    externalIds: {
      rows: externalIdRows,
      collision: planSlotCollisions({
        keeperRows: externalIdRows.filter(
          (row) => row.productId === input.keepId,
        ),
        loserRows: externalIdRows.filter(
          (row) => row.productId !== input.keepId,
        ),
        slotKey: externalIdSlot,
      }),
    },
    images: planAssociation({
      rows: imageRows,
      keepId: input.keepId,
      slotKey: (row) => row.imageId,
    }),
    projectUses: planAssociation({
      rows: projectUseRows,
      keepId: input.keepId,
      slotKey: (row) => row.projectId,
    }),
    purchases: planAssociation({
      rows: purchaseRows,
      keepId: input.keepId,
      slotKey: (row) => row.purchaseId,
    }),
    wishes: planAssociation({
      rows: wishRows,
      keepId: input.keepId,
      slotKey: (row) => row.wishId,
    }),
    expenses,
    tasks,
    locations,
    cookbooks,
    conversionCoverage,
    survivorImageIds: imageRows
      .filter((row) => row.productId === input.keepId)
      .map((row) => row.id),
    aliases,
    aliasesAdded: aliases.filter((alias) => !existingAliases.has(alias)),
    tags: uniq([...keeper.tags, ...losers.flatMap((row) => row.tags)]),
    carried,
  };
}

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

    // Rebuild after the locks: preview is advisory, while this is the plan the
    // executor is allowed to trust.
    const plan = await buildProductMergePlan(tx, { keepId, loserIds });
    const { keeper, losers } = plan;
    if (losers.length === 0) {
      return emptySummary(keeper.shortcode, keepId);
    }

    const now = new Date();
    const summary: ProductMergeSummary = emptySummary(keeper.shortcode, keepId);
    summary.deletedIds = losers.map((row) =>
      unsafeProductShortcode(row.shortcode),
    );
    summary.deletedEntityIds = losers.map((row) => row.id);

    const inventoryPlan = plan.inventory;
    const isbns = distinctIsbns(plan.externalIds.rows);
    if (isbns.length > 1) {
      throw createAppError(
        "PRODUCT_MERGE_DISTINCT_ISBNS",
        `Cannot merge Products with different ISBN editions (${isbns.join(", ")}). Correct or remove an ISBN first.`,
      );
    }
    if (inventoryPlan.mismatches.length > 0) {
      const detail = inventoryPlan.mismatches
        .map(({ row, into }) => `${row.amount.unit} vs ${into.amount.unit}`)
        .join(", ");
      throw createAppError(
        "PRODUCT_MERGE_INVENTORY_UNIT_MISMATCH",
        `Cannot merge products stocked in the same location under different units (${detail}). Convert one entry first.`,
      );
    }

    // Both component refusals are computed BEFORE anything is written. The
    // transaction would roll back either way, but a preview and a mutation that
    // refuse for the same reason at the same point are much easier to keep
    // honest than one that discovers it halfway through.
    const componentPlan = plan.components;
    if (componentPlan.cycle) {
      throw createAppError(
        "PRODUCT_MERGE_COMPONENT_CYCLE",
        `Cannot merge: the result would contain itself (${await describeProductPath(tx, componentPlan.cycle)}). Detach the kit link first.`,
      );
    }
    if (componentPlan.kit.conflicts.length > 0) {
      const detail = await Promise.all(
        componentPlan.kit.conflicts.map(async ({ into, rows }) => {
          const part = await describeProductPath(tx, [into.componentProductId]);
          const quantities = uniq([
            into.quantity,
            ...rows.map((row) => row.quantity),
          ]).join(" vs ");
          return `${part} (${quantities})`;
        }),
      );
      throw createAppError(
        "PRODUCT_MERGE_COMPONENT_QUANTITY_MISMATCH",
        `Cannot merge kits that list the same component in different quantities: ${detail.join(", ")}. Correct one list first.`,
      );
    }

    const externalIdRows = plan.externalIds.rows;
    const externalIdPlan = plan.externalIds.collision;

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
    const demotedExternalIds: string[] = [];
    const discardedUnitMappings: string[] = [];
    for (const { into, rows } of externalIdPlan.absorb) {
      // Fill-never-overwrite, resolved across the WHOLE group: with two losers
      // on one slot, checking `into.url` per row would let the last one win.
      const filledUrl =
        into.url ?? rows.find((row) => row.url != null)?.url ?? null;
      if (into.url == null && filledUrl != null) {
        await tx
          .update(productExternalId)
          .set({ url: filledUrl })
          .where(eq(productExternalId.id, into.id));
      }
      // A slot holds one PRIMARY, not one row, so a colliding loser moves onto
      // the survivor as a secondary instead of being destroyed.
      //
      // Every row here necessarily carries a DIFFERENT value from `into`: the
      // global unique on (source, kind, externalId) forbids two live rows
      // sharing one, so "the keeper already has this exact id" cannot occur and
      // there is no redundant case to drop.
      await tx
        .update(productExternalId)
        .set({ productId: keepId, isPrimary: false })
        .where(
          inArray(
            productExternalId.id,
            rows.map((row) => row.id),
          ),
        );
      for (const row of rows) {
        summary.externalIdsDemoted.push({
          source: row.source,
          // The column is text and predates the enum, so legacy rows can hold
          // a value outside it — same cast `mapProductExternalIds` makes.
          kind: row.kind as ExternalIdKind,
          externalId: row.externalId,
        });
        demotedExternalIds.push(
          `${row.source}/${row.kind}=${row.externalId} (secondary; ${into.externalId} stays primary)`,
        );
      }
    }
    // Same repair the patch path ends with: a slot the merge touched must not
    // be left with rows but no primary. Reachable here because the loser's own
    // primary can be demoted on the way in — and the `contract` migration
    // created exactly that shape (primary + secondary in one amazon/asin slot)
    // on the five products this change was written for.
    await ensureSlotPrimaries(tx, keepId, externalIdRows);

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
    let inventoryMerged = 0;
    for (const { into, rows } of inventoryPlan.absorb) {
      // Sum the WHOLE group in one write. Per-row updates would each read the
      // unmutated `into.amount` and overwrite rather than accumulate, quietly
      // dropping stock when a shelf takes more than one absorbed entry.
      const absorbed = sumBy(rows, (row) => row.amount.value);
      const to = { ...into.amount, value: into.amount.value + absorbed };
      await tx
        .update(inventoryEntry)
        .set({ amount: to })
        .where(eq(inventoryEntry.id, into.id));
      const absorbedIds = rows.map((row) => row.id);
      await tx
        .update(inventoryEntry)
        .set({ deletedAt: now })
        .where(inArray(inventoryEntry.id, absorbedIds));
      // The survivor's `update` entry and the absorbed rows' `delete` entries
      // land in one batch, so the buffered arm rather than the immediate one.
      const entries: AuditEntryInput[] = [
        {
          entityType: "inventory",
          entityId: into.id,
          action: "update",
          changes: { amount: { from: into.amount, to } },
        },
      ];
      await cascadeRemoval(tx, {
        entity: "inventory",
        ids: absorbedIds,
        audit: { into: entries },
      });
      await logAuditEntries(tx, actor, entries);
      inventoryMerged += rows.length;
    }
    summary.inventoryMerged = inventoryMerged;

    // Four edges, one shape: re-point what fits, soft-delete the duplicate.
    // An absorbed row here carries no data the survivor's row doesn't already
    // have (the pair IS the row), so there is nothing to fold.
    //
    // Images are the exception, and it is about ORDER rather than data. The
    // cover is whichever row sorts first under
    // `asc(sortOrder), asc(createdAt)`, `sortOrder` defaults to 0 on every
    // legacy row, and `foldAssociation` re-points without touching it — so a
    // merged-in image that happened to be created earlier silently became the
    // survivor's cover. (A barcode scan hijacked a product's cover exactly this
    // way.) Read the survivor's own rows in their current order first, then
    // renumber survivor-first once the fold has moved everything across.
    const survivorImagesBefore = plan.survivorImageIds.map((id) => ({ id }));
    summary.imagesMoved = await foldAssociation(tx, {
      column: "productId",
      table: productImage,
      rows: plan.images.rows,
      keepId,
      slotKey: (row) => row.imageId,
      now,
      plan: plan.images.collision,
    });
    if (summary.imagesMoved > 0 && survivorImagesBefore.length > 0) {
      const survivorFirst = new Set(survivorImagesBefore.map((row) => row.id));
      const afterFold = await tx.query.productImage.findMany({
        where: and(
          eq(productImage.productId, keepId),
          notDeleted(productImage),
        ),
        columns: { id: true },
        orderBy: [asc(productImage.sortOrder), asc(productImage.createdAt)],
      });
      const ordered = [
        ...survivorImagesBefore.map((row) => row.id),
        ...afterFold
          .map((row) => row.id)
          .filter((id) => !survivorFirst.has(id)),
      ];
      for (const [index, id] of ordered.entries()) {
        await tx
          .update(productImage)
          .set({ sortOrder: index })
          .where(eq(productImage.id, id));
      }
    }
    summary.projectUsesMoved = await foldAssociation(tx, {
      column: "productId",
      table: projectToolUsage,
      rows: plan.projectUses.rows,
      keepId,
      slotKey: (row) => row.projectId,
      now,
      plan: plan.projectUses.collision,
    });
    summary.purchaseLinksMoved = await foldAssociation(tx, {
      column: "productId",
      table: purchaseProduct,
      rows: plan.purchases.rows,
      keepId,
      slotKey: (row) => row.purchaseId,
      now,
      plan: plan.purchases.collision,
    });
    summary.wishCandidatesMoved = await foldAssociation(tx, {
      column: "productId",
      table: wishCandidate,
      rows: plan.wishes.rows,
      keepId,
      slotKey: (row) => row.wishId,
      now,
      plan: plan.wishes.collision,
    });

    // Composition, both directions. Nothing here needs its own audit entry:
    // a dedupe drops a row identical to one that survives, and a sum preserves
    // the total, so unlike a discarded external id there is no value to name.
    if (componentPlan.kit.repoint.length > 0) {
      await tx
        .update(productComponent)
        .set({ parentProductId: keepId })
        .where(
          inArray(
            productComponent.id,
            componentPlan.kit.repoint.map((row) => row.id),
          ),
        );
      summary.componentsMoved = componentPlan.kit.repoint.length;
    }
    if (componentPlan.kit.dedupe.length > 0) {
      await tx
        .update(productComponent)
        .set({ deletedAt: now })
        .where(
          inArray(
            productComponent.id,
            componentPlan.kit.dedupe.map((row) => row.id),
          ),
        );
      summary.componentsDeduped = componentPlan.kit.dedupe.length;
    }
    if (componentPlan.part.repoint.length > 0) {
      await tx
        .update(productComponent)
        .set({ componentProductId: keepId })
        .where(
          inArray(
            productComponent.id,
            componentPlan.part.repoint.map((row) => row.id),
          ),
        );
      summary.kitLinksMoved = componentPlan.part.repoint.length;
    }
    let kitLinksSummed = 0;
    for (const { into, rows } of componentPlan.part.absorb) {
      // Summed per GROUP, not per row — one kit can list three parts that all
      // merge into the survivor, and per-row updates would each read the
      // unmutated `into.quantity` and overwrite rather than accumulate.
      await tx
        .update(productComponent)
        .set({ quantity: into.quantity + sumBy(rows, (row) => row.quantity) })
        .where(eq(productComponent.id, into.id));
      await tx
        .update(productComponent)
        .set({ deletedAt: now })
        .where(
          inArray(
            productComponent.id,
            rows.map((row) => row.id),
          ),
        );
      kitLinksSummed += rows.length;
    }
    summary.kitLinksSummed = kitLinksSummed;

    const unitMappingPlan = plan.unitMappings;

    if (unitMappingPlan.repoint.length > 0) {
      await tx
        .update(productUnitMappings)
        .set({ productId: keepId })
        .where(
          inArray(
            productUnitMappings.id,
            unitMappingPlan.repoint.map((row) => row.id),
          ),
        );
      summary.unitMappingsMoved = unitMappingPlan.repoint.length;
    }
    if (unitMappingPlan.absorbed.length > 0) {
      // Absorbed edges are DROPPED, not moved as secondaries: there is no
      // `isPrimary` to hide behind here, and a second live row for the same
      // pair is exactly the defect this fold exists to prevent.
      await tx
        .update(productUnitMappings)
        .set({ deletedAt: now })
        .where(
          inArray(
            productUnitMappings.id,
            unitMappingPlan.absorbed.map(({ row }) => row.id),
          ),
        );
      for (const { row, into, redundant } of unitMappingPlan.absorbed) {
        if (redundant) {
          summary.unitMappingsDeduped += 1;
          continue;
        }
        // BOTH ratios are stated per 1 of the discarded row's own `from` unit,
        // so the two numbers are directly comparable and agree with the
        // `from`/`to` labels beside them. Reporting each in its own canonical
        // direction would print reciprocals of what the rows say.
        summary.unitMappingsDiscarded.push({
          from: row.a.unit,
          to: row.b.unit,
          keptRatio: ratioPerUnit(into, row.a.unit),
          discardedRatio: ratioPerUnit(row, row.a.unit),
          source: row.source,
        });
        discardedUnitMappings.push(
          `${row.a.value} ${row.a.unit} = ${row.b.value} ${row.b.unit} (dropped; ${into.a.value} ${into.a.unit} = ${into.b.value} ${into.b.unit} stays)`,
        );
      }
    }
    const movedTasks = await tx
      .update(task)
      .set({ subjectProductId: keepId })
      .where(
        and(inArray(task.subjectProductId, plan.loserIds), notDeleted(task)),
      )
      .returning({ id: task.id });
    summary.tasksMoved = movedTasks.length;
    const movedLocations = await tx
      .update(location)
      .set({ productId: keepId })
      .where(
        and(inArray(location.productId, plan.loserIds), notDeleted(location)),
      )
      .returning({ id: location.id });
    summary.locationsMoved = movedLocations.length;
    const movedCookbooks = await tx
      .update(cookbook)
      .set({ productId: keepId })
      .where(
        and(inArray(cookbook.productId, plan.loserIds), notDeleted(cookbook)),
      )
      .returning({ id: cookbook.id });
    summary.cookbooksMoved = movedCookbooks.length;
    // Money moving between products is an AUDITED change, exactly as it is on
    // `updateExpense` and in `foldChargeInto`'s purchaseId re-point — net cost
    // and the owned/sold window are derived from these rows.
    const movedExpenses = await tx
      .update(expense)
      .set({ productId: keepId })
      .where(
        and(inArray(expense.productId, plan.loserIds), notDeleted(expense)),
      )
      .returning({ id: expense.id });
    summary.expensesMoved = movedExpenses.length;
    await logAuditEntries(
      tx,
      actor,
      movedExpenses.map(({ id }) => ({
        entityType: "expense" as const,
        entityId: id,
        action: "update" as const,
        changes: { productId: { from: null, to: keepId } },
      })),
    );

    const folded = plan.aliases;
    summary.aliasesAdded = plan.aliasesAdded;
    const tags = plan.tags;

    const carried = plan.carried;
    summary.carriedFields = Object.keys(carried);

    await tx
      .update(product)
      .set({
        aliases: folded,
        tags,
        ...buildPartialUpdateValues(carried),
      })
      .where(eq(product.id, keepId));

    if (plan.conversionCoverage.length > 0) {
      await tx.delete(productConversionCoverage).where(
        inArray(
          productConversionCoverage.productId,
          plan.conversionCoverage.map((row) => row.id as ProductId),
        ),
      );
    }

    const { removed } = await finalizeMerge(tx, {
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
        ...(demotedExternalIds.length > 0
          ? { demotedExternalIds: { from: null, to: demotedExternalIds } }
          : {}),
        ...(discardedUnitMappings.length > 0
          ? { discardedUnitMappings: { from: null, to: discardedUnitMappings } }
          : {}),
      },
    });
    summary.merged = removed;

    // Every moved entry now values at the KEEPER's effective price; without
    // this a re-pointed row keeps a valuation derived from a product that no
    // longer exists, and the location rollup silently reports the old number.
    await syncInventoryValuationsForProduct(tx, keepId);
    // Moved mappings, adopted food identity and kit composition all change the
    // survivor's effective conversion graph. Absorbed rows are no longer live;
    // the survivor must wait for the shared rebuild before it can match a
    // persisted conversion filter.
    await markProductConversionCoverageInputStale(tx, [keepId]);

    return summary;
  });
};

const emptySummary = (
  shortcode: string,
  keepEntityId: ProductId,
): ProductMergeSummary => ({
  keepId: unsafeProductShortcode(shortcode),
  deletedIds: [],
  merged: 0,
  keepEntityId,
  deletedEntityIds: [],
  externalIdsMoved: 0,
  externalIdsDemoted: [],
  inventoryMoved: 0,
  inventoryMerged: 0,
  expensesMoved: 0,
  imagesMoved: 0,
  unitMappingsMoved: 0,
  unitMappingsDeduped: 0,
  unitMappingsDiscarded: [],
  tasksMoved: 0,
  locationsMoved: 0,
  cookbooksMoved: 0,
  projectUsesMoved: 0,
  purchaseLinksMoved: 0,
  wishCandidatesMoved: 0,
  componentsMoved: 0,
  componentsDeduped: 0,
  kitLinksMoved: 0,
  kitLinksSummed: 0,
  aliasesAdded: [],
  carriedFields: [],
});

/**
 * What `mergeProducts` would do to the given products, without doing it.
 *
 * Reads the SAME `PRODUCT_MERGE_EDGE_POLICY` the mutation writes against, and
 * runs the SAME `planInventoryFold` and `planProductComponentMerge` — so the
 * three refusals (unit mismatch, kit-graph cycle, disagreeing component
 * quantities) show up as blockers the dialog can disable confirmation on,
 * instead of only surfacing as an error toast after the merge was attempted.
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
  // Refuses exactly where the mutation refuses. This used to silently filter
  // the keeper out of the loser set, mirroring the same silent filter
  // `resolveMergeTargets` used to make — so preview and mutation agreed on a
  // merge neither of them was actually going to perform.
  assertDistinctMergeTargets("product", keepId, input.mergeIds);
  const losers = input.mergeIds;
  if (losers.length === 0) {
    return { blockers: [], changes: [], sideEffects: [] };
  }
  const dbClient = getDb(db);
  const plan = await buildProductMergePlan(
    dbClient,
    { keepId, loserIds: losers },
    { allowMissingKeeper: true },
  );
  if (plan === null) {
    return { blockers: [], changes: [], sideEffects: [] };
  }
  const inventoryPlan = plan.inventory;
  const unitMappingPlan = plan.unitMappings;
  const componentPlan = plan.components;
  const isbns = distinctIsbns(plan.externalIds.rows);
  // Blockers are labelled, not just described: `ImpactRow` renders
  // total/label/code and never `description`, so naming the cycle or the
  // disagreeing quantities anywhere else would make them invisible in the UI.
  const cycleLabel = componentPlan.cycle
    ? `merge would make a product contain itself (${await describeProductPath(dbClient, componentPlan.cycle)})`
    : null;

  const byProduct = (rows: Array<{ productId: ProductId }>) => {
    const out: Record<string, number> = {};
    for (const row of rows) out[row.productId] = (out[row.productId] ?? 0) + 1;
    return out;
  };

  const blockers = present([
    impact({
      disposition: {
        code: "block-distinct-isbn-editions",
        effect: "block",
        description:
          "Different ISBNs identify different physical editions or formats. Correct or remove an ISBN before merging these Products.",
      },
      edgeKey: "ProductExternalId.productId",
      label:
        isbns.length > 1
          ? `distinct ISBN editions (${isbns.join(", ")})`
          : "distinct ISBN editions",
      byTargetId:
        isbns.length > 1
          ? byProduct(
              plan.externalIds.rows.filter(
                (row) =>
                  row.source === "gtin" &&
                  isbnFromGtin(row.externalId) !== null,
              ),
            )
          : {},
    }),
    impact({
      disposition: {
        code: "block-component-cycle",
        effect: "block",
        description:
          "A product cannot be its own component, at any depth. Merging these would close a loop in the kit graph; detach the kit link first.",
      },
      edgeKey: "ProductComponent.parentProductId",
      label: cycleLabel ?? "kit graph cycles",
      // One per loser: the cycle is a property of the identification itself,
      // not of any single row, so there is no row to attribute it to.
      byTargetId: cycleLabel
        ? Object.fromEntries(losers.map((id) => [id, 1]))
        : {},
    }),
    impact({
      disposition: {
        code: "block-component-quantity-mismatch",
        effect: "block",
        description:
          "Both kits list the same component but disagree on how many, and only one row can survive the (parentProductId, componentProductId) index. Correct one list first.",
      },
      edgeKey: "ProductComponent.parentProductId",
      label: "components listed at conflicting quantities",
      byTargetId: byProduct(
        componentPlan.kit.conflicts.flatMap(({ rows }) =>
          rows.map((row) => ({ productId: row.parentProductId })),
        ),
      ),
    }),
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
      disposition: {
        code: "soft-delete-merged-product",
        effect: "soft-delete",
        description:
          "Each merged-away Product becomes a permanent shortcode tombstone after its consequences are folded into the survivor.",
      },
      label: "products merged into the survivor",
      byTargetId: Object.fromEntries(plan.loserIds.map((id) => [id, 1])),
    }),
    impact({
      disposition: {
        code: "carry-product-aliases",
        effect: "preserve",
        description:
          "Merged names and aliases are added to the survivor so old descriptions remain searchable.",
      },
      label: "names or aliases added to the survivor",
      byTargetId:
        plan.aliasesAdded.length > 0
          ? { [keepId]: plan.aliasesAdded.length }
          : {},
    }),
    impact({
      disposition: {
        code: "carry-product-fields",
        effect: "preserve",
        description: `Empty survivor fields filled without overwriting existing values: ${
          Object.keys(plan.carried)
            .map((field) => CARRIED_FIELD_LABELS[field as CarriedColumn])
            .join(", ") || "none"
        }.`,
      },
      label: "empty survivor fields filled",
      byTargetId:
        Object.keys(plan.carried).length > 0
          ? { [keepId]: Object.keys(plan.carried).length }
          : {},
    }),
    impact({
      disposition: {
        code: "carry-product-tags",
        effect: "preserve",
        description:
          "Tags present only on merged-away Products are added to the survivor.",
      },
      label: "tags added to the survivor",
      byTargetId: {
        [keepId]: plan.tags.filter((tag) => !plan.keeper.tags.includes(tag))
          .length,
      },
    }),
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
      byTargetId: byProduct(inventoryPlan.absorb.flatMap(({ rows }) => rows)),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["ProductExternalId.productId"],
      edgeKey: "ProductExternalId.productId",
      label: "external ids moved",
      byTargetId: byProduct(plan.externalIds.collision.repoint),
    }),
    impact({
      disposition: {
        code: "demote-conflicting-external-id",
        effect: "move-dedupe",
        description:
          "The survivor already fills this source and kind slot. The merged identifier is retained as a secondary while the survivor's identifier stays primary.",
      },
      edgeKey: "ProductExternalId.productId",
      label: "conflicting external ids kept as secondary",
      byTargetId: byProduct(
        plan.externalIds.collision.absorb.flatMap(({ rows }) => rows),
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["Expense.productId"],
      edgeKey: "Expense.productId",
      label: "ledger lines re-pointed",
      byTargetId: byProduct(plan.expenses),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["ProductUnitMappings.productId"],
      edgeKey: "ProductUnitMappings.productId",
      label: "unit mappings re-pointed",
      byTargetId: byProduct(unitMappingPlan.repoint),
    }),
    impact({
      disposition: {
        code: "drop-duplicate-conversion",
        effect: "move-dedupe",
        description:
          "A conversion the survivor already states at the same ratio is dropped as a true duplicate.",
      },
      edgeKey: "ProductUnitMappings.productId",
      label: "duplicate unit mappings dropped",
      byTargetId: byProduct(
        unitMappingPlan.absorbed
          .filter(({ redundant }) => redundant)
          .map(({ row }) => row),
      ),
    }),
    // Its own row, and labelled rather than described: `ImpactRow` renders the
    // label and never `description`, so a contradiction folded into the line
    // above would be indistinguishable from a harmless duplicate — which is the
    // whole thing an operator needs to see before confirming.
    impact({
      disposition: {
        code: "discard-conflicting-conversion",
        effect: "move-dedupe",
        description:
          "The survivor already answers this unit pair with a DIFFERENT ratio. Its edge stands; the merged product's is dropped and named in the audit trail.",
      },
      edgeKey: "ProductUnitMappings.productId",
      label: "conflicting unit mappings discarded (survivor's ratio wins)",
      byTargetId: byProduct(
        unitMappingPlan.absorbed
          .filter(({ redundant }) => !redundant)
          .map(({ row }) => row),
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["ProductImage.productId"],
      edgeKey: "ProductImage.productId",
      label: "image associations moved",
      byTargetId: byProduct(plan.images.collision.repoint),
    }),
    impact({
      disposition: {
        code: "drop-duplicate-image-association",
        effect: "move-dedupe",
        description:
          "The survivor already has this image, so the duplicate association is soft-deleted and the survivor's existing image order wins.",
      },
      edgeKey: "ProductImage.productId",
      label: "duplicate image associations dropped",
      byTargetId: byProduct(
        plan.images.collision.absorb.flatMap(({ rows }) => rows),
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["Task.subjectProductId"],
      edgeKey: "Task.subjectProductId",
      label: "tasks re-pointed",
      byTargetId: byProduct(plan.tasks),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["ProjectToolUsage.productId"],
      edgeKey: "ProjectToolUsage.productId",
      label: "project uses moved",
      byTargetId: byProduct(plan.projectUses.collision.repoint),
    }),
    impact({
      disposition: {
        code: "drop-duplicate-project-use",
        effect: "move-dedupe",
        description:
          "The project already lists the survivor, so the duplicate Product use is soft-deleted.",
      },
      edgeKey: "ProjectToolUsage.productId",
      label: "duplicate project uses dropped",
      byTargetId: byProduct(
        plan.projectUses.collision.absorb.flatMap(({ rows }) => rows),
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["PurchaseProduct.productId"],
      edgeKey: "PurchaseProduct.productId",
      label: "purchase links moved",
      byTargetId: byProduct(plan.purchases.collision.repoint),
    }),
    impact({
      disposition: {
        code: "drop-duplicate-purchase-link",
        effect: "move-dedupe",
        description:
          "The Purchase already links the survivor, so the duplicate Product link is soft-deleted.",
      },
      edgeKey: "PurchaseProduct.productId",
      label: "duplicate purchase links dropped",
      byTargetId: byProduct(
        plan.purchases.collision.absorb.flatMap(({ rows }) => rows),
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["WishCandidate.productId"],
      edgeKey: "WishCandidate.productId",
      label: "wishlist candidacies moved",
      byTargetId: byProduct(plan.wishes.collision.repoint),
    }),
    impact({
      disposition: {
        code: "drop-duplicate-wish-candidate",
        effect: "move-dedupe",
        description:
          "The Wish already names the survivor as a candidate, so the duplicate candidacy is soft-deleted.",
      },
      edgeKey: "WishCandidate.productId",
      label: "duplicate wishlist candidacies dropped",
      byTargetId: byProduct(
        plan.wishes.collision.absorb.flatMap(({ rows }) => rows),
      ),
    }),
    impact({
      disposition:
        PRODUCT_MERGE_EDGE_POLICY["ProductComponent.parentProductId"],
      edgeKey: "ProductComponent.parentProductId",
      label: "kit component rows moved",
      byTargetId: byProduct(
        componentPlan.kit.repoint.map((row) => ({
          productId: row.parentProductId,
        })),
      ),
    }),
    impact({
      disposition: {
        code: "dedupe-identical-component",
        effect: "move-dedupe",
        description:
          "The survivor already lists this component at the same quantity, so the duplicate row is soft-deleted rather than moved.",
      },
      edgeKey: "ProductComponent.parentProductId",
      label: "duplicate component rows deduped",
      byTargetId: byProduct(
        componentPlan.kit.dedupe.map((row) => ({
          productId: row.parentProductId,
        })),
      ),
    }),
    impact({
      disposition:
        PRODUCT_MERGE_EDGE_POLICY["ProductComponent.componentProductId"],
      edgeKey: "ProductComponent.componentProductId",
      label: "kit memberships moved",
      byTargetId: byProduct(
        componentPlan.part.repoint.map((row) => ({
          productId: row.componentProductId,
        })),
      ),
    }),
    impact({
      disposition: {
        code: "sum-same-kit-quantity",
        effect: "move-dedupe",
        description:
          "One kit listed two of the merged products, so their quantities are summed into the survivor's row and the absorbed row is soft-deleted.",
      },
      edgeKey: "ProductComponent.componentProductId",
      label: "kit quantities summed into the survivor",
      byTargetId: byProduct(
        componentPlan.part.absorb.flatMap(({ rows }) =>
          rows.map((row) => ({ productId: row.componentProductId })),
        ),
      ),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["Location.productId"],
      edgeKey: "Location.productId",
      label: "locations re-pointed",
      byTargetId: byProduct(plan.locations),
    }),
    impact({
      disposition: PRODUCT_MERGE_EDGE_POLICY["Cookbook.productId"],
      edgeKey: "Cookbook.productId",
      label: "cookbooks re-pointed",
      byTargetId: byProduct(plan.cookbooks),
    }),
    impact({
      disposition:
        PRODUCT_MERGE_EDGE_POLICY["ProductConversionCoverage.productId"],
      edgeKey: "ProductConversionCoverage.productId",
      label: "conversion coverage projections discarded",
      byTargetId: byProduct(plan.conversionCoverage),
    }),
  ]);

  const sideEffects = [
    sideEffect({
      code: "resync-inventory-valuations",
      label: "stock entries re-valued",
      description:
        "Every surviving stock entry re-values at the surviving Product's effective price.",
      total:
        inventoryPlan.rows.length -
        inventoryPlan.absorb.reduce((sum, group) => sum + group.rows.length, 0),
    }),
    sideEffect({
      code: "rebuild-conversion-coverage",
      label: "survivor conversion coverage marked for rebuild",
      description:
        "Moved mappings, carried food identity, and kit composition can change the survivor's conversion graph, so its rebuildable projection is marked stale.",
      total: 1,
    }),
    sideEffect({
      code: "preserve-survivor-image-order",
      label: "survivor image order retained ahead of moved images",
      description:
        "Existing survivor images keep their relative priority so an older merged image cannot silently become the cover.",
      total:
        plan.images.collision.repoint.length > 0 &&
        plan.survivorImageIds.length > 0
          ? plan.survivorImageIds.length
          : 0,
    }),
  ].filter((item) => item.total > 0);

  return { blockers, changes, sideEffects };
};
