import type { Amount } from "@cubby/schemas/codec";
/** Merge duplicate Products without silently discarding identity, stock, or conversion evidence.
 * Preserve keeper values; validate component cycles and surface irreconcilable slot conflicts. */
import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import {
  type ExternalIdKind,
  externalIdKind,
} from "@cubby/schemas/external-id";
import {
  type InventoryId,
  type ProductId,
  type ProductShortcode,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import type { InventoryPlacement } from "@cubby/schemas/inventory";
import type { InventoryOwnershipMode } from "@cubby/schemas/inventory-ownership";
import {
  hasFoodIndicators,
  type MergeProductsInput,
} from "@cubby/schemas/product";
import {
  isProjectResourceFeature,
  projectResourceFeatureLabels,
} from "@cubby/schemas/product-category-fields";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { sumBy, uniq } from "es-toolkit";

import { wasm } from "~/lib/wasm";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  cookbook,
  device,
  entityAttachment,
  expense,
  importRunEvidence,
  importRunTarget,
  inventoryEntry,
  location,
  mealFoodEntry,
  photoGroupProposal,
  planting,
  product,
  productComponent,
  productConversionCoverage,
  productExternalId,
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
import {
  getCategoryFeature,
  resolveProductCategory,
} from "~/server/repo/product-category";
import { repointProductMatchCandidatesTx } from "~/server/repo/product-match-candidate";
import { cascadeRemoval } from "~/server/repo/removal";

import { validateLiveEffectiveTrades } from "../inheritance-validation";
import { markProductConversionCoverageInputStale } from "./conversion-coverage";
import { ensureSlotPrimaries } from "./update-helpers";

export const PRODUCT_MERGE_EDGE_POLICY = {
  "ImportRunTarget.productId": {
    code: "repoint-targeted-import-history",
    effect: "repoint",
    description: "Targeted enrichment history follows the surviving Product.",
  },
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
  "EntityAttachment.subjectEntityId": {
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
  "MealFoodEntry.productId": {
    code: "repoint-meal-food-entries",
    effect: "repoint",
    description:
      "Recorded meal food entries move onto the surviving product while their gram amounts remain fixed.",
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
  "ProductMatchCandidate.productAId": {
    code: "repoint-match-review",
    effect: "repoint",
    description:
      "Match-queue reviews naming a merged-away product move onto the survivor so agent evidence survives; the merged pair itself is dropped as a self-pair and a colliding pair folds, keeping any dismissal.",
  },
  "ProductMatchCandidate.productBId": {
    code: "repoint-match-review",
    effect: "repoint",
    description:
      "Match-queue reviews naming a merged-away product move onto the survivor so agent evidence survives; the merged pair itself is dropped as a self-pair and a colliding pair folds, keeping any dismissal.",
  },
  "Planting.sourceProductId": {
    code: "preserve-garden-source",
    effect: "preserve",
    description:
      "Planting provenance retains the merged product tombstone rather than rewriting its recorded source.",
  },
  "Device.productId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description:
      "A device whose hardware was merged away re-points onto the survivor, the same plain repoint as a Location or Cookbook.",
  },
  "PhotoGroupProposal.productId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description:
      "A photo group proposal that chose (or committed to) a merged-away product follows the survivor.",
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
  // NOT NULL with "" as its empty value: a purchase-created Product starts
  // with no manufacturer, so a photo-created loser's brand must fill it.
  "manufacturer",
  "fdc_id",
  "model",
  "price",
  "notes",
  "categoryId",
  "ingredientId",
  "expectedQuantity",
  // Nullable on purpose (`presenceFilter` exposes "undecided" as a real
  // state), so a deliberate `false` on a merged-away kit is a value the
  // survivor's null slot should adopt — not a default to be re-derived.
  "stockTracked",
] as const;
type CarriedColumn = (typeof CARRIED_COLUMNS)[number];

const CARRIED_FIELD_LABELS = {
  manufacturer: "manufacturer",
  fdc_id: "USDA food identity",
  model: "model",
  price: "price",
  notes: "notes",
  categoryId: "classification",
  ingredientId: "linked ingredient",
  expectedQuantity: "expected quantity",
  stockTracked: "stock-tracking decision",
} satisfies Record<CarriedColumn, string>;

type ProductMergeSource = Pick<
  typeof product.$inferSelect,
  "id" | "shortcode" | "name" | "aliases" | "tags" | CarriedColumn
>;
type ProductMergeRow = Omit<ProductMergeSource, "id" | "shortcode"> & {
  id: ProductId;
  shortcode: ProductShortcode;
};
type ProductCarriedValues = Partial<Pick<ProductMergeRow, CarriedColumn>>;

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
  inventoryMerged: number;
  expensesMoved: number;
  imagesMoved: number;
  unitMappingsMoved: number;
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
  /** Devices whose linked hardware was merged away, re-pointed onto the survivor. */
  devicesMoved: number;
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

const externalIdSlot = (row: { source: string; kind: string }) =>
  `${row.source}\u0000${row.kind}`;

type InventoryRow = {
  id: InventoryId;
  productId: ProductId;
  locationId: string;
  placement: InventoryPlacement;
  ownershipMode: InventoryOwnershipMode;
  ownerLedgerPartyId: LedgerPartyId | null;
  amount: Amount;
};

/** Raw ownership is part of the slot; inferred ownership never is. */
const inventorySlot = (row: InventoryRow) =>
  [
    row.locationId,
    row.placement,
    row.ownershipMode,
    row.ownerLedgerPartyId ?? "none",
  ].join("\u0000");

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

interface ComponentRow {
  id: string;
  parentProductId: ProductId;
  componentProductId: ProductId;
  quantity: number;
}

/** Reject a merge when the complete projected component graph contains a direct or transitive cycle. */
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
  kit: {
    repoint: ComponentRow[];
    /** Same part, same quantity, already on the survivor's list — drop. */
    dedupe: ComponentRow[];
    /** Same part, DIFFERENT quantity — the merge must refuse. */
    conflicts: Array<{ into: ComponentRow; rows: ComponentRow[] }>;
  };
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
  kind: ExternalIdKind;
  externalId: string;
  url: string | null;
  isPrimary: boolean;
};

const distinctIsbns = (rows: readonly ExternalIdRow[]): string[] =>
  uniq(
    rows.flatMap((row) => {
      if (row.source !== "gtin") return [];
      const isbn = wasm.isbn_from_gtin(row.externalId);
      return isbn ? [isbn.isbn13] : [];
    }),
  );

type ProductAssociationRow = {
  id: string;
  productId: ProductId;
};

type ProductImageAssociationRow = ProductAssociationRow & {
  imageId: string;
  sha256: string | null;
  purpose: "item" | "label" | null;
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
  mealFoodEntries: ProductAssociationRow[];
  conversionCoverage: ProductAssociationRow[];
  sourcePlantings: ProductAssociationRow[];
  survivorImageIds: string[];
  aliases: string[];
  aliasesAdded: string[];
  tags: string[];
  carried: ProductCarriedValues;
  carriedFields: CarriedColumn[];
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
  const productRows = (
    await db.query.product.findMany({
      where: and(inArray(product.id, requestedIds), notDeleted(product)),
      columns: {
        id: true,
        shortcode: true,
        name: true,
        aliases: true,
        tags: true,
        manufacturer: true,
        fdc_id: true,
        model: true,
        price: true,
        notes: true,
        categoryId: true,
        ingredientId: true,
        expectedQuantity: true,
        stockTracked: true,
      },
    })
  ).map((row): ProductMergeRow => ({
    ...row,
    id: parseEntityId("product", row.id),
    shortcode: parseShortcodeFor("product", row.shortcode),
  }));
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
  const inventoryRows = (
    await db.query.inventoryEntry.findMany({
      where: and(
        inArray(inventoryEntry.productId, ids),
        notDeleted(inventoryEntry),
      ),
      columns: {
        id: true,
        productId: true,
        locationId: true,
        placement: true,
        ownershipMode: true,
        ownerLedgerPartyId: true,
        amount: true,
      },
    })
  ).map((row): InventoryRow => ({
    ...row,
    id: parseEntityId("inventory", row.id),
    productId: parseEntityId("product", row.productId),
  }));
  const componentRows = await loadComponentRows(db);
  const unitMappingRows = (
    await db.query.productUnitMappings.findMany({
      where: and(
        inArray(productUnitMappings.productId, ids),
        notDeleted(productUnitMappings),
      ),
      columns: { id: true, productId: true, a: true, b: true, source: true },
      orderBy: [
        asc(productUnitMappings.createdAt),
        asc(productUnitMappings.id),
      ],
    })
  ).map((row): UnitMappingRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
  }));
  const externalIdRows = (
    await db.query.productExternalId.findMany({
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
    })
  ).map((row): ExternalIdRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
    kind: externalIdKind.parse(row.kind),
  }));
  const imageRows = (
    await db.query.entityAttachment.findMany({
      where: and(
        inArray(entityAttachment.subjectEntityId, ids),
        notDeleted(entityAttachment),
      ),
      columns: {
        id: true,
        subjectEntityId: true,
        imageId: true,
        purpose: true,
        sortOrder: true,
        createdAt: true,
      },
      with: { image: { columns: { sha256: true } } },
      orderBy: [
        asc(entityAttachment.sortOrder),
        asc(entityAttachment.createdAt),
      ],
    })
  ).map(({ subjectEntityId, ...row }): ProductImageAssociationRow => ({
    ...row,
    productId: parseEntityId("product", subjectEntityId),
    sha256: row.image.sha256,
  }));
  const projectUseRows = (
    await db.query.projectToolUsage.findMany({
      where: and(
        inArray(projectToolUsage.productId, ids),
        notDeleted(projectToolUsage),
      ),
      columns: { id: true, productId: true, projectId: true },
    })
  ).map((row): ProjectUseAssociationRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
  }));
  const purchaseRows = (
    await db.query.purchaseProduct.findMany({
      where: and(
        inArray(purchaseProduct.productId, ids),
        notDeleted(purchaseProduct),
      ),
      columns: { id: true, productId: true, purchaseId: true },
    })
  ).map((row): PurchaseAssociationRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
  }));
  const wishRows = (
    await db.query.wishCandidate.findMany({
      where: and(
        inArray(wishCandidate.productId, ids),
        notDeleted(wishCandidate),
      ),
      columns: { id: true, productId: true, wishId: true },
    })
  ).map((row): WishAssociationRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
  }));
  const expenses = (
    await db
      .select({ id: expense.id, productId: expense.productId })
      .from(expense)
      .where(and(inArray(expense.productId, liveLoserIds), notDeleted(expense)))
  ).map((row): ProductAssociationRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
  }));
  const tasks = (
    await db
      .select({ id: task.id, productId: task.subjectProductId })
      .from(task)
      .where(
        and(inArray(task.subjectProductId, liveLoserIds), notDeleted(task)),
      )
  ).map((row): ProductAssociationRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
  }));
  const locations = (
    await db
      .select({ id: location.id, productId: location.productId })
      .from(location)
      .where(
        and(inArray(location.productId, liveLoserIds), notDeleted(location)),
      )
  ).map((row): ProductAssociationRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
  }));
  const cookbooks = (
    await db
      .select({ id: cookbook.id, productId: cookbook.productId })
      .from(cookbook)
      .where(
        and(inArray(cookbook.productId, liveLoserIds), notDeleted(cookbook)),
      )
  ).map((row): ProductAssociationRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
  }));
  const mealFoodEntries = (
    await db
      .select({ id: mealFoodEntry.id, productId: mealFoodEntry.productId })
      .from(mealFoodEntry)
      .where(
        and(
          inArray(mealFoodEntry.productId, liveLoserIds),
          notDeleted(mealFoodEntry),
        ),
      )
  ).map((row): ProductAssociationRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
  }));
  const conversionCoverage = (
    await db
      .select({
        id: productConversionCoverage.productId,
        productId: productConversionCoverage.productId,
      })
      .from(productConversionCoverage)
      .where(inArray(productConversionCoverage.productId, liveLoserIds))
  ).map((row): ProductAssociationRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
  }));
  const sourcePlantings = (
    await db
      .select({ id: planting.id, productId: planting.sourceProductId })
      .from(planting)
      .where(
        and(
          inArray(planting.sourceProductId, liveLoserIds),
          notDeleted(planting),
        ),
      )
  ).map((row): ProductAssociationRow => ({
    ...row,
    productId: parseEntityId("product", row.productId),
  }));
  const aliases = uniq([
    ...keeper.aliases,
    ...losers.map((row) => row.name),
    ...losers.flatMap((row) => row.aliases ?? []),
  ]).filter((alias) => alias !== keeper.name);
  const existingAliases = new Set(keeper.aliases);
  const carried: ProductCarriedValues = {};
  const carriedFields: CarriedColumn[] = [];
  const isEmpty = (value: ProductMergeRow[CarriedColumn]): boolean =>
    value == null || value === "";
  const carryColumn = <K extends CarriedColumn>(column: K): void => {
    if (!isEmpty(keeper[column])) return;
    const donor = losers.find((row) => !isEmpty(row[column]));
    if (donor) {
      carried[column] = donor[column];
      carriedFields.push(column);
    }
  };
  for (const column of CARRIED_COLUMNS) {
    carryColumn(column);
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
      // A repeated attachment row is not the only duplicate: separate Image
      // records can contain the same bytes when an upload was retried or
      // imported through two paths. Exact verified bytes share a slot; an
      // unverified image keeps the old UUID-based behavior rather than making
      // a guess from filename or perceptual similarity.
      slotKey: (row) =>
        row.sha256 ? `sha256\u0000${row.sha256}` : `image\u0000${row.imageId}`,
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
    mealFoodEntries,
    conversionCoverage,
    sourcePlantings,
    survivorImageIds: imageRows
      .filter((row) => row.productId === input.keepId)
      .map((row) => row.id),
    aliases,
    aliasesAdded: aliases.filter((alias) => !existingAliases.has(alias)),
    tags: uniq([...keeper.tags, ...losers.flatMap((row) => row.tags)]),
    carried,
    carriedFields,
  };
}

type ProductMergeCategoryAdmission = {
  categoryId: ProductMergeRow["categoryId"];
  feature: Awaited<ReturnType<typeof getCategoryFeature>>;
  hasProjectUses: boolean;
  keeperIsGardenSource: boolean;
};

/**
 * A merge can carry food/ISBN evidence and re-point resource edges at once.
 * Resolve the survivor's final category before either write so the same
 * admission rules as a direct category change protect the merged graph.
 */
const admitMergedProductCategory = async (
  tx: DrizzleTransaction,
  plan: ProductMergePlan,
): Promise<ProductMergeCategoryAdmission> => {
  const fdc_id = plan.keeper.fdc_id ?? plan.carried.fdc_id ?? null;
  const ingredientId =
    plan.keeper.ingredientId ?? plan.carried.ingredientId ?? null;
  const requiredFeature = hasFoodIndicators({ fdc_id, ingredientId })
    ? "food"
    : distinctIsbns(plan.externalIds.rows).length > 0
      ? "books"
      : null;
  const categoryId = await resolveProductCategory(
    tx,
    plan.keeper.categoryId ?? plan.carried.categoryId ?? null,
    requiredFeature,
  );
  const feature = await getCategoryFeature(tx, categoryId);
  const keeperGardenSource = await tx.query.planting.findFirst({
    where: and(
      eq(planting.sourceProductId, plan.keeper.id),
      notDeleted(planting),
    ),
    columns: { id: true },
  });
  return {
    categoryId,
    feature,
    hasProjectUses: plan.projectUses.rows.length > 0,
    keeperIsGardenSource: keeperGardenSource !== undefined,
  };
};

const validateProductMergePlan = async (
  tx: DrizzleTransaction,
  plan: ProductMergePlan,
): Promise<ProductMergeCategoryAdmission> => {
  const isbns = distinctIsbns(plan.externalIds.rows);
  if (isbns.length > 1) {
    throw createAppError(
      "PRODUCT_MERGE_DISTINCT_ISBNS",
      `Cannot merge Products with different ISBN editions (${isbns.join(", ")}). Correct or remove an ISBN first.`,
    );
  }
  if (plan.inventory.mismatches.length > 0) {
    const detail = plan.inventory.mismatches
      .map(({ row, into }) => `${row.amount.unit} vs ${into.amount.unit}`)
      .join(", ");
    throw createAppError(
      "PRODUCT_MERGE_INVENTORY_UNIT_MISMATCH",
      `Cannot merge products stocked in the same location under different units (${detail}). Convert one entry first.`,
    );
  }

  // Both component refusals are computed before anything is written so
  // preview and mutation reject the same plan at the same boundary.
  if (plan.components.cycle) {
    throw createAppError(
      "PRODUCT_MERGE_COMPONENT_CYCLE",
      `Cannot merge: the result would contain itself (${await describeProductPath(tx, plan.components.cycle)}). Detach the kit link first.`,
    );
  }
  if (plan.components.kit.conflicts.length > 0) {
    const detail = await Promise.all(
      plan.components.kit.conflicts.map(async ({ into, rows }) => {
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
  const admission = await admitMergedProductCategory(tx, plan);
  if (
    admission.hasProjectUses &&
    !isProjectResourceFeature(admission.feature)
  ) {
    throw createAppError(
      "PRODUCT_CATEGORY_INELIGIBLE",
      `A Product used as a project resource must be in a category that allows project resources (${projectResourceFeatureLabels}).`,
    );
  }
  if (admission.keeperIsGardenSource && admission.feature === "food") {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A planting source Product must be a garden product, not a food Product.",
    );
  }
  return admission;
};

const foldProductExternalIds = async (
  tx: DrizzleTransaction,
  keepId: ProductId,
  plan: ProductMergePlan,
  summary: ProductMergeSummary,
): Promise<string[]> => {
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

  const demoted: string[] = [];
  for (const { into, rows } of externalIdPlan.absorb) {
    // Fill-never-overwrite across the whole collision group.
    const filledUrl =
      into.url ?? rows.find((row) => row.url != null)?.url ?? null;
    if (into.url == null && filledUrl != null) {
      await tx
        .update(productExternalId)
        .set({ url: filledUrl })
        .where(eq(productExternalId.id, into.id));
    }
    // A slot holds one primary. Conflicting loser identities survive as
    // secondaries and are named in both the response and audit trail.
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
        kind: row.kind,
        externalId: row.externalId,
      });
      demoted.push(
        `${row.source}/${row.kind}=${row.externalId} (secondary; ${into.externalId} stays primary)`,
      );
    }
  }
  await ensureSlotPrimaries(tx, keepId, plan.externalIds.rows);
  return demoted;
};

type ProductMergeSurvivorChanges = {
  mergedFrom: { from: null; to: ProductId[] };
  carriedOver?: { from: null; to: ProductCarriedValues };
  demotedExternalIds?: { from: null; to: string[] };
  discardedUnitMappings?: { from: null; to: string[] };
};

const productMergeSurvivorChanges = (
  plan: ProductMergePlan,
  mergedFrom: ProductId[],
  summary: ProductMergeSummary,
  demotedExternalIds: string[],
  discardedUnitMappings: string[],
): ProductMergeSurvivorChanges => {
  const changes: ProductMergeSurvivorChanges = {
    mergedFrom: { from: null, to: mergedFrom },
  };
  if (summary.carriedFields.length > 0) {
    changes.carriedOver = { from: null, to: plan.carried };
  }
  if (demotedExternalIds.length > 0) {
    changes.demotedExternalIds = { from: null, to: demotedExternalIds };
  }
  if (discardedUnitMappings.length > 0) {
    changes.discardedUnitMappings = {
      from: null,
      to: discardedUnitMappings,
    };
  }
  return changes;
};

/**
 * Merge `mergeIds` into `keepId`.
 *
 * Re-points or folds all sixteen incoming edges (see the file doc for the two
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

  // eslint-disable-next-line complexity -- merge folds every incoming Product edge atomically.
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
      parseShortcodeFor("product", row.shortcode),
    );
    summary.deletedEntityIds = losers.map((row) => row.id);

    const categoryAdmission = await validateProductMergePlan(tx, plan);
    if (categoryAdmission.categoryId !== plan.keeper.categoryId) {
      plan.carried.categoryId = categoryAdmission.categoryId;
      if (!plan.carriedFields.includes("categoryId")) {
        plan.carriedFields.push("categoryId");
      }
    }

    const inventoryPlan = plan.inventory;
    const componentPlan = plan.components;
    const discardedUnitMappings: string[] = [];
    const demotedExternalIds = await foldProductExternalIds(
      tx,
      keepId,
      plan,
      summary,
    );

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
    // A direct keeper choice is authoritative.  Legacy null has no choice,
    // so retain a surviving loser's explicit role when deduplicating the
    // same image across Products.
    for (const { into, rows } of plan.images.collision.absorb) {
      if (into.purpose !== null) continue;
      const purpose = rows.find((row) => row.purpose !== null)?.purpose;
      if (purpose)
        await tx
          .update(entityAttachment)
          .set({ purpose })
          .where(eq(entityAttachment.id, into.id));
    }
    summary.imagesMoved = await foldAssociation(tx, {
      column: "productId",
      table: entityAttachment,
      // A retry key was scoped to the loser; it must not become reusable
      // against the survivor (ADR 0006).
      repointValues: (subjectEntityId) => ({
        subjectEntityId,
        idempotencyKey: null,
      }),
      softDeleteValues: (deletedAt) => ({ deletedAt }),
      rows: plan.images.rows,
      keepId,
      slotKey: (row) => row.imageId,
      now,
      plan: plan.images.collision,
    });
    if (summary.imagesMoved > 0 && survivorImagesBefore.length > 0) {
      const survivorFirst = new Set(survivorImagesBefore.map((row) => row.id));
      const afterFold = await tx.query.entityAttachment.findMany({
        where: and(
          eq(entityAttachment.subjectEntityId, keepId),
          notDeleted(entityAttachment),
        ),
        columns: { id: true },
        orderBy: [
          asc(entityAttachment.sortOrder),
          asc(entityAttachment.createdAt),
        ],
      });
      const ordered = [
        ...survivorImagesBefore.map((row) => row.id),
        ...afterFold
          .map((row) => row.id)
          .filter((id) => !survivorFirst.has(id)),
      ];
      for (const [index, id] of ordered.entries()) {
        await tx
          .update(entityAttachment)
          .set({ sortOrder: index })
          .where(eq(entityAttachment.id, id));
      }
    }
    summary.projectUsesMoved = await foldAssociation(tx, {
      column: "productId",
      table: projectToolUsage,
      repointValues: (productId) => ({ productId }),
      softDeleteValues: (deletedAt) => ({ deletedAt }),
      rows: plan.projectUses.rows,
      keepId,
      slotKey: (row) => row.projectId,
      now,
      plan: plan.projectUses.collision,
    });
    summary.purchaseLinksMoved = await foldAssociation(tx, {
      column: "productId",
      table: purchaseProduct,
      repointValues: (productId) => ({ productId }),
      softDeleteValues: (deletedAt) => ({ deletedAt }),
      rows: plan.purchases.rows,
      keepId,
      slotKey: (row) => row.purchaseId,
      now,
      plan: plan.purchases.collision,
    });
    summary.wishCandidatesMoved = await foldAssociation(tx, {
      column: "productId",
      table: wishCandidate,
      repointValues: (productId) => ({ productId }),
      softDeleteValues: (deletedAt) => ({ deletedAt }),
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
    const movedDevices = await tx
      .update(device)
      .set({ productId: keepId })
      .where(and(inArray(device.productId, plan.loserIds), notDeleted(device)))
      .returning({ id: device.id });
    summary.devicesMoved = movedDevices.length;
    await tx
      .update(photoGroupProposal)
      .set({ productId: keepId, updatedAt: new Date() })
      .where(inArray(photoGroupProposal.productId, plan.loserIds));
    await tx
      .update(mealFoodEntry)
      .set({ productId: keepId })
      .where(
        and(
          inArray(mealFoodEntry.productId, plan.loserIds),
          notDeleted(mealFoodEntry),
        ),
      );
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
    // Preserve the keeper's target when both Products were inspected in the
    // same run; re-pointing all rows at once would violate the partial unique
    // `(runId, productId)` index.
    const targetedRuns = await tx
      .select({ id: importRunTarget.id, runId: importRunTarget.runId })
      .from(importRunTarget)
      .where(inArray(importRunTarget.productId, plan.loserIds));
    for (const target of targetedRuns) {
      const [existing] = await tx
        .select({ id: importRunTarget.id })
        .from(importRunTarget)
        .where(
          and(
            eq(importRunTarget.runId, target.runId),
            eq(importRunTarget.productId, keepId),
          ),
        )
        .limit(1);
      if (existing) {
        await tx
          .update(importRunEvidence)
          .set({ targetId: existing.id })
          .where(eq(importRunEvidence.targetId, target.id));
        await tx
          .delete(importRunTarget)
          .where(eq(importRunTarget.id, target.id));
      } else {
        await tx
          .update(importRunTarget)
          .set({ productId: keepId, updatedAt: new Date() })
          .where(eq(importRunTarget.id, target.id));
      }
    }
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
    summary.carriedFields = plan.carriedFields;

    await tx
      .update(product)
      .set({
        aliases: folded,
        tags,
        ...buildPartialUpdateValues(carried),
      })
      .where(eq(product.id, keepId));

    await repointProductMatchCandidatesTx(tx, keepId, plan.loserIds);

    if (plan.conversionCoverage.length > 0) {
      await tx.delete(productConversionCoverage).where(
        inArray(
          productConversionCoverage.productId,
          plan.conversionCoverage.map((row) =>
            parseEntityId("product", row.id),
          ),
        ),
      );
    }

    const survivorChanges = productMergeSurvivorChanges(
      plan,
      loserIds,
      summary,
      demotedExternalIds,
      discardedUnitMappings,
    );

    const { removed } = await finalizeMerge(tx, {
      entity: "product",
      table: product,
      keepId,
      loserIds,
      removal: "soft",
      actor,
      survivorChanges,
    });
    summary.merged = removed;
    await validateLiveEffectiveTrades(tx);

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
  keepId: parseShortcodeFor("product", shortcode),
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
  devicesMoved: 0,
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
  // Read-only admission uses a transaction so it resolves the same inherited
  // category feature and keeper planting edge as the atomic executor.
  const categoryAdmission = await withTransaction(db, async (tx) =>
    admitMergedProductCategory(tx, plan),
  );
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
                  wasm.isbn_from_gtin(row.externalId) != null,
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
    impact({
      disposition: {
        code: "block-project-resource-category-ineligible",
        effect: "block",
        description:
          "Project resource usage requires a category that allows project resources (Tools, Tool accessories, Software). The merged survivor would no longer be eligible.",
      },
      edgeKey: "ProjectToolUsage.productId",
      label: "project uses that require an eligible category",
      byTargetId:
        categoryAdmission.hasProjectUses &&
        !isProjectResourceFeature(categoryAdmission.feature)
          ? byProduct(plan.projectUses.rows)
          : {},
    }),
    impact({
      disposition: {
        code: "block-garden-source-food-category",
        effect: "block",
        description:
          "A planting source Product cannot be classified as Food. The keeper remains the source after merging.",
      },
      edgeKey: "Planting.sourceProductId",
      label: "planting source that cannot become Food",
      byTargetId:
        categoryAdmission.keeperIsGardenSource &&
        categoryAdmission.feature === "food"
          ? { [keepId]: 1 }
          : {},
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
          plan.carriedFields
            .map((field) => CARRIED_FIELD_LABELS[field])
            .join(", ") || "none"
        }.`,
      },
      label: "empty survivor fields filled",
      byTargetId:
        plan.carriedFields.length > 0
          ? { [keepId]: plan.carriedFields.length }
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
      disposition:
        PRODUCT_MERGE_EDGE_POLICY["EntityAttachment.subjectEntityId"],
      edgeKey: "EntityAttachment.subjectEntityId",
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
      edgeKey: "EntityAttachment.subjectEntityId",
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
      disposition: PRODUCT_MERGE_EDGE_POLICY["MealFoodEntry.productId"],
      edgeKey: "MealFoodEntry.productId",
      label: "meal food entries re-pointed",
      byTargetId: byProduct(plan.mealFoodEntries),
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
      code: "preserve-planting-source-product",
      label: "plantings retain merged source product provenance",
      description:
        "Live plantings keep the merged product tombstone as their recorded source rather than rewriting history.",
      total: plan.sourcePlantings.length,
      byTargetId: byProduct(plan.sourcePlantings),
    }),
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
