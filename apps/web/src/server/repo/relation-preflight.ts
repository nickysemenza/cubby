/**
 * The shared pre-validation behind the three `<parent> ← product` relation
 * families — `ProductComponent`, `ProjectToolUsage`, and `PurchaseProduct`.
 *
 * All three used to spell the same refusal as `liveX.length !== requested.length
 * → throw`, which computes exactly the failing set and then discards it: the
 * caller learned that *something* among five ids was wrong and had to bisect to
 * find out which. The shapes here carry that set forward instead, so both the
 * mutation's refusal and the preview's blockers can name the offending
 * shortcodes.
 *
 * ## Transaction boundary
 *
 * Every `preflight*` function built on this takes a
 * `DrizzleClient | DrizzleTransaction` and issues its queries **sequentially**,
 * which is what lets one predicate serve both call sites:
 *
 * - the MUTATION passes its `tx`, because the checks and the write must see one
 *   snapshot;
 * - the PREVIEW passes the pooled client, because it writes nothing.
 *
 * Nothing in here may become a `Promise.all` — pg refuses a second query on a
 * client that is already executing one, so a concurrent read that is harmless
 * on the pooled client is fatal inside a transaction. Project attachment's
 * timeline guard is the counter-example and is deliberately NOT folded in here:
 * it fans out with `Promise.all` and therefore must run BEFORE
 * `withTransaction` (see `findToolTimelineConflicts` in `repo/project/tools.ts`).
 * Share the predicate, not the call site.
 */

import type {
  ImpactItem,
  PublicImpactItem,
} from "@cubby/schemas/entity-integrity";
import { toPublicImpact } from "@cubby/schemas/entity-integrity";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { AppErrorReason } from "@cubby/shared";
import { inArray, sql } from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { product } from "~/server/db/schema";
import { createBlockedError } from "~/server/errors/app-error";
import { categoryFeatureSql } from "~/server/repo/product-category-sql";

/**
 * What a relation pre-validation found, in the id space the repo works in.
 *
 * Every field is a subset of the ids the CALLER named, so the refusal and the
 * preview can both attribute their answer to particular rows. One shape for all
 * three families; a family that cannot produce a given bucket leaves it empty
 * rather than the shape splitting per family.
 */
export interface RelationPreflight {
  /**
   * The distinct product ids the caller named, in request order. The parent is
   * NOT in here even when it is itself a Product — the buckets below are all
   * subsets of this, and the preview's per-target breakdown is keyed off it.
   */
  requested: ProductId[];
  /**
   * The parent row itself is gone. Kept apart from `missing` because each
   * family refuses it with its OWN reason (`PROJECT_NOT_FOUND`,
   * `PURCHASE_NOT_FOUND`, `PRODUCT_NOT_FOUND`) and because a dead parent makes
   * every other bucket meaningless.
   */
  parentMissing: boolean;
  /** Requested product ids with no live `Product` row. */
  missing: ProductId[];
  /**
   * Live products the parent's category gate rejects. Project resources only —
   * a `ProjectToolUsage` row may only name a `tools` or `software` Product.
   * Kept apart from `missing` because conflating them is the defect this
   * module exists to fix: `PRODUCT_NOT_FOUND` for a product that plainly
   * exists sends the caller looking for a typo that isn't there.
   */
  ineligible: ProductId[];
  /**
   * Requested ids that already sit in the state being asked for — already
   * attached on an attach, already absent on a detach. Not a blocker: this is
   * the `alreadySatisfied` bucket `relationMutationOut` reports, computed
   * before the write instead of inferred from the row count after it.
   */
  alreadySatisfied: ProductId[];
  /** The parent named among its own components. `ProductComponent` only. */
  selfReference: ProductId[];
  /**
   * Rendered shortcode path of the component cycle the attach would close, or
   * `null`. `ProductComponent` only.
   */
  cyclePath: string | null;
  /**
   * Public shortcode for every requested id the preflight could name,
   * INCLUDING soft-deleted rows — a refusal has to render the code the caller
   * passed, and a soft-deleted product still has one.
   */
  codeById: Map<string, string>;
}

export const emptyPreflight = (): RelationPreflight => ({
  requested: [],
  parentMissing: false,
  missing: [],
  ineligible: [],
  alreadySatisfied: [],
  selfReference: [],
  cyclePath: null,
  codeById: new Map(),
});

interface RelationProductRow {
  id: ProductId;
  shortcode: string;
  /** Nullable in the schema — an uncategorized Product is never eligible. */
  reusable: boolean;
  live: boolean;
}

/**
 * Load the requested product rows, live or not.
 *
 * Deliberately queries WITHOUT a liveness filter so a soft-deleted row still
 * yields its shortcode: naming `PRD-9F2K` is the whole point, and "one of these
 * five is wrong" is the answer being replaced. Liveness is then read off the
 * row rather than off the filter.
 *
 * Sequential by construction — see the transaction-boundary note at the top.
 */
export async function loadRelationProducts(
  dbc: DrizzleClient | DrizzleTransaction,
  productIds: readonly ProductId[],
): Promise<{ rows: RelationProductRow[]; codeById: Map<string, string> }> {
  if (productIds.length === 0) return { rows: [], codeById: new Map() };
  const found = await dbc
    .select({
      id: product.id,
      shortcode: product.shortcode,
      reusable: sql<boolean>`(
        ${categoryFeatureSql(sql`${product.categoryId}`, "tools")}
        OR ${categoryFeatureSql(sql`${product.categoryId}`, "software")}
      )`,
      deletedAt: product.deletedAt,
    })
    .from(product)
    .where(inArray(product.id, [...productIds]));
  const rows: RelationProductRow[] = found.map((row) => ({
    id: row.id,
    shortcode: row.shortcode,
    reusable: Boolean(row.reusable),
    live: row.deletedAt === null,
  }));
  return {
    rows,
    codeById: new Map(rows.map((row) => [row.id, row.shortcode])),
  };
}

/**
 * Turn one bucket of blocked ids into an `ImpactItem`.
 *
 * uuid-keyed, like every other planner in the codebase: `byTargetId` carries
 * the raw database id inside the server, and `toPublicImpact` is the only way
 * out to shortcodes. That is what lets the SAME item feed both a preview (which
 * the dispatcher translates) and a mutation refusal (translated below).
 */
export function relationImpact(opts: {
  code: string;
  label: string;
  description: string;
  ids: readonly string[];
}): ImpactItem | null {
  if (opts.ids.length === 0) return null;
  return {
    code: opts.code,
    effect: "block",
    label: opts.label,
    description: opts.description,
    total: opts.ids.length,
    byTargetId: Object.fromEntries(opts.ids.map((id) => [id, 1])),
  };
}

/** Drop the nulls `relationImpact` returns for an empty bucket. */
const presentImpacts = (
  items: ReadonlyArray<ImpactItem | null>,
): ImpactItem[] => items.filter((item): item is ImpactItem => item !== null);

/** What every relation preview planner returns — the dispatcher's `Planned`. */
export interface RelationPlan {
  blockers: ImpactItem[];
  changes: ImpactItem[];
}

/**
 * `byTargetId` is empty on purpose: the blocked row is the PARENT, which is not
 * one of the per-target ids this breakdown is keyed by.
 */
const PARENT_MISSING_BLOCKER: ImpactItem = {
  code: "block-relation-parent-not-live",
  effect: "block",
  label: "parent is not live",
  description:
    "The row the edge would hang off does not exist or has been deleted.",
  total: 1,
  byTargetId: {},
};

interface RelationEdgeCopy {
  edgeKey: string;
  /** Short noun phrase naming the edge rows — e.g. "kit components". */
  label: string;
  description: string;
}

/**
 * Project one preflight into the preview's blockers/changes.
 *
 * Deliberately built from `RelationPreflight` and nothing else, so a preview
 * cannot answer a question the mutation doesn't ask: every bucket here is one
 * the pre-validation already computed.
 */
export function planRelationAttach(
  pre: RelationPreflight,
  copy: RelationEdgeCopy,
): RelationPlan {
  const blocked = new Set<string>([
    ...pre.missing,
    ...pre.ineligible,
    ...pre.selfReference,
  ]);
  const willAttach = pre.parentMissing
    ? []
    : pre.requested.filter(
        (id) => !blocked.has(id) && !pre.alreadySatisfied.includes(id),
      );
  return {
    blockers: presentImpacts([
      pre.parentMissing ? PARENT_MISSING_BLOCKER : null,
      relationImpact({
        code: "block-component-self-reference",
        label: "self-referencing targets",
        description: "A Product cannot be listed inside itself.",
        ids: pre.selfReference,
      }),
      relationImpact({
        code: "block-relation-target-not-live",
        label: "products that are not live",
        description:
          "A Product named here does not exist or has been deleted, so the edge cannot be written.",
        ids: pre.missing,
      }),
      relationImpact({
        code: "block-product-category-ineligible",
        label: "products of the wrong category",
        description:
          "The Product exists and is live, but its category is not one this relation accepts.",
        ids: pre.ineligible,
      }),
      pre.cyclePath
        ? {
            code: "block-component-cycle",
            effect: "block" as const,
            label: "component cycle",
            description: `Attaching would close a cycle: ${pre.cyclePath}.`,
            total: 1,
            byTargetId: {},
          }
        : null,
    ]),
    changes: presentImpacts([
      relationImpact({
        code: "relation-already-attached",
        label: "already attached",
        description:
          "Already a live edge — re-asserting it writes nothing (the `alreadySatisfied` bucket).",
        ids: pre.alreadySatisfied,
      }),
      edgeImpact("relation-attach", "preserve", willAttach, copy),
    ]),
  };
}

/** The non-blocking half of a plan: rows the write would actually touch. */
function edgeImpact(
  code: string,
  effect: "preserve" | "soft-delete",
  ids: readonly string[],
  copy: RelationEdgeCopy,
): ImpactItem | null {
  if (ids.length === 0) return null;
  return {
    code,
    effect,
    edgeKey: copy.edgeKey,
    label: copy.label,
    description: copy.description,
    total: ids.length,
    byTargetId: Object.fromEntries(ids.map((id) => [id, 1])),
  };
}

export function planRelationDetach(
  pre: RelationPreflight,
  copy: RelationEdgeCopy,
): RelationPlan {
  const willDetach = pre.requested.filter(
    (id) => !pre.alreadySatisfied.includes(id),
  );
  return {
    // A detach has no blockers at all — including a dead parent. It is
    // idempotent by construction: a pair that was never linked is reported as
    // already-satisfied rather than refused, and none of the three detach
    // mutations checks the parent, because removing an edge from a row that is
    // gone is already a no-op. A preview that refused here would contradict the
    // mutation it describes.
    blockers: [],
    changes: presentImpacts([
      relationImpact({
        code: "relation-already-detached",
        label: "nothing to remove",
        description:
          "No live edge for this pair — never linked, or already removed.",
        ids: pre.alreadySatisfied,
      }),
      edgeImpact("relation-detach", "soft-delete", willDetach, copy),
    ]),
  };
}

/**
 * Throw a refusal that NAMES the offending shortcodes, both in the sentence a
 * human reads and as structured blockers a client can branch on.
 *
 * Translation is best-effort for the same reason `deleteFinancialAccounts`
 * gives: this is already an error path, and swapping a typed
 * `PRODUCT_CATEGORY_INELIGIBLE` for a raw "no public id for target" would hide
 * the real answer behind a bookkeeping detail.
 */
export function throwRelationRefusal(opts: {
  reason: AppErrorReason;
  /** Receives the offending shortcodes, comma-joined, already rendered. */
  message: (codes: string) => string;
  items: ReadonlyArray<ImpactItem | null>;
  ids: readonly string[];
  codeById: ReadonlyMap<string, string>;
}): never {
  const codes = opts.ids.map((id) => opts.codeById.get(id) ?? "?");
  let blockers: PublicImpactItem[] = [];
  try {
    blockers = presentImpacts(opts.items).map((item) =>
      toPublicImpact(item, opts.codeById, "throw"),
    );
  } catch {
    // SILENT: see the docstring above — the typed `createBlockedError` thrown
    // below is the refusal itself; losing the structured `blockers[]` extra
    // must not replace it with a bookkeeping-detail error instead.
    blockers = [];
  }
  throw createBlockedError(
    opts.reason,
    opts.message(codes.join(", ")),
    blockers,
  );
}
