import type { RelationMutationOut } from "@cubby/schemas/common";
import type { ActorContext } from "@cubby/schemas/context";
import type { ImpactItem } from "@cubby/schemas/entity-integrity";
import type { ProductId, ProjectId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  isProjectResourceFeature,
  projectResourceFeatureLabels,
  projectResourceFeatures,
} from "@cubby/schemas/product-category-fields";
import type {
  ProductProjectUsesOut,
  ProjectResourceOut,
  ProjectSharedWindowOut,
  ProjectToolSuggestionOut,
  ProjectToolSuggestionsOut,
  ReusableResourceCategory,
  Trade,
} from "@cubby/schemas/project";
import { isLiveProjectStatus } from "@cubby/schemas/project";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";

import { householdLocalDate } from "~/lib/household-date";
import {
  describeToolTimelineConflict,
  type ToolTimelineProjectWindow,
  toolTimelineConflict,
  UNKNOWN_OWNERSHIP,
} from "~/lib/tool-timeline";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  expense,
  inventoryEntry,
  product,
  project,
  projectToolUsage,
  task,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
} from "~/server/repo/expense-inheritance";
import { foldAssociation } from "~/server/repo/merge";
import { getProductCoverImageUrlsByProductIds } from "~/server/repo/product";
import { getCategoryFeature } from "~/server/repo/product-category";
import {
  categoryFeatureInSql,
  categoryFeatureSql,
} from "~/server/repo/product-category-sql";
import { loadProductOwnershipTimelines } from "~/server/repo/product/ownership";
import type { EntityRelationMutationAdapter } from "~/server/repo/relation-mutation-adapter";
import {
  emptyPreflight,
  loadRelationProducts,
  planRelationAttach,
  planRelationDetach,
  type RelationPlan,
  type RelationPreflight,
  relationImpact,
  throwRelationRefusal,
} from "~/server/repo/relation-preflight";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import {
  effectiveTaskProjectSql,
  effectiveTaskTradeSql,
} from "~/server/repo/task-project-inheritance";

import { maxPlainDate } from "./helpers";
import { collectDescendantIds, loadProjectDateWindows } from "./subtree";

export const EXPENSIVE_TOOL_THRESHOLD = 100;
export const REUSED_CHEAP_TOOL_PROJECTS = 2;
export const MAX_TRADE_SUGGESTIONS = 20;
export const MAX_SUGGESTIONS_PER_TRADE = 5;
const effectiveExpenseProject = effectiveExpenseProjectSql();
const effectiveExpenseTrade = effectiveExpenseTradeSql();
const effectiveTaskProject = effectiveTaskProjectSql();
const effectiveTaskTrade = effectiveTaskTradeSql();

/** Project-resource features that land in the `'tools'` bucket — everything
 * eligible except `software`, which is its own bucket. A `tool-accessories`
 * product (e.g. a jig or guide) is a tool for bucket purposes. */
const TOOL_BUCKET_FEATURES = projectResourceFeatures.filter(
  (feature) => feature !== "software",
);

const reusableCategorySql = () =>
  sql<ReusableResourceCategory | null>`CASE
    WHEN ${categoryFeatureInSql(sql`${product.categoryId}`, TOOL_BUCKET_FEATURES)} THEN 'tools'
    WHEN ${categoryFeatureSql(sql`${product.categoryId}`, "software")} THEN 'software'
    ELSE NULL
  END`;

/** Same bucket mapping as `reusableCategorySql`, for a feature already resolved
 * in TypeScript (e.g. via `getCategoryFeature`). */
const reusableBucketFor = (
  feature: Awaited<ReturnType<typeof getCategoryFeature>>,
): ReusableResourceCategory | null =>
  feature === "software"
    ? "software"
    : feature !== null && TOOL_BUCKET_FEATURES.includes(feature)
      ? "tools"
      : null;

export type ResourceMetrics = {
  projectUseCount: number;
  netLifetimeCost: number;
  costPerProjectUse: number | null;
  grossLifetimeAcquisitionCost: number;
};

export const EMPTY_METRICS: ResourceMetrics = {
  projectUseCount: 0,
  netLifetimeCost: 0,
  costPerProjectUse: null,
  grossLifetimeAcquisitionCost: 0,
};

export async function loadResourceMetrics(
  dbc: DrizzleClient,
  productIds: ProductId[],
): Promise<Map<ProductId, ResourceMetrics>> {
  const result = new Map<ProductId, ResourceMetrics>();
  if (productIds.length === 0) return result;

  const [usageRows, costRows] = await Promise.all([
    dbc
      .select({
        productId: projectToolUsage.productId,
        projectUseCount: countDistinct(projectToolUsage.projectId),
      })
      .from(projectToolUsage)
      .where(
        and(
          inArray(projectToolUsage.productId, productIds),
          notDeleted(projectToolUsage),
        ),
      )
      .groupBy(projectToolUsage.productId),
    dbc
      .select({
        productId: expense.productId,
        netLifetimeCost: sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(
          Number,
        ),
        grossLifetimeAcquisitionCost:
          sql<number>`coalesce(sum(CASE WHEN ${expense.costType} = 'tools' AND ${expense.cost} > 0 THEN ${expense.cost} ELSE 0 END), 0)`.mapWith(
            Number,
          ),
      })
      .from(expense)
      .where(
        and(
          inArray(expense.productId, productIds),
          eq(expense.lineKind, "principal"),
          eq(expense.future, false),
          notDeleted(expense),
        ),
      )
      .groupBy(expense.productId),
  ]);

  for (const productId of productIds)
    result.set(productId, { ...EMPTY_METRICS });
  for (const row of usageRows) {
    const current = result.get(row.productId) ?? { ...EMPTY_METRICS };
    current.projectUseCount = Number(row.projectUseCount);
    result.set(row.productId, current);
  }
  for (const row of costRows) {
    if (!row.productId) continue;
    const current = result.get(row.productId) ?? { ...EMPTY_METRICS };
    current.netLifetimeCost = row.netLifetimeCost;
    current.grossLifetimeAcquisitionCost = row.grossLifetimeAcquisitionCost;
    result.set(row.productId, current);
  }
  for (const metrics of result.values()) {
    metrics.costPerProjectUse =
      metrics.projectUseCount === 0
        ? null
        : metrics.netLifetimeCost / metrics.projectUseCount;
  }
  return result;
}

type ResourceReadOptions = {
  today?: string;
};

type ResourceWindowContext = {
  sharedWindow: Omit<ProjectSharedWindowOut, "netCost">;
  excludedProjectIds: Set<ProjectId>;
};

type LoadedProjectDateWindows = Awaited<
  ReturnType<typeof loadProjectDateWindows>
>;

function buildResourceWindowContexts(
  loaded: LoadedProjectDateWindows,
  projectIds: ProjectId[],
  today: string,
): Map<ProjectId, ResourceWindowContext | null> {
  const projectById = new Map(loaded.tree.allRows.map((row) => [row.id, row]));
  const result = new Map<ProjectId, ResourceWindowContext | null>();

  for (const projectId of projectIds) {
    const row = projectById.get(projectId);
    const window = loaded.dateWindows.get(projectId);
    const startDate = window?.effectiveStart ?? null;
    const endDate = row
      ? isLiveProjectStatus(row.status)
        ? maxPlainDate(window?.effectiveEnd ?? null, today)
        : (window?.effectiveEnd ?? null)
      : null;

    if (startDate === null || endDate === null || startDate > endDate) {
      result.set(projectId, null);
      continue;
    }

    result.set(projectId, {
      sharedWindow: { startDate, endDate },
      excludedProjectIds: new Set([
        projectId,
        ...collectDescendantIds(loaded.tree.childrenByParent, projectId),
      ]),
    });
  }

  return result;
}

export type ProjectTimelineGate = {
  window: ToolTimelineProjectWindow;
  isLive: boolean;
};

export function buildTimelineGates(
  loaded: LoadedProjectDateWindows,
  projectIds: ProjectId[],
): Map<ProjectId, ProjectTimelineGate> {
  const projectById = new Map(loaded.tree.allRows.map((row) => [row.id, row]));
  const result = new Map<ProjectId, ProjectTimelineGate>();
  for (const projectId of projectIds) {
    const row = projectById.get(projectId);
    const window = loaded.dateWindows.get(projectId);
    if (!row || !window) continue;
    result.set(projectId, {
      window,
      isLive: isLiveProjectStatus(row.status),
    });
  }
  return result;
}

function publicResourceMetrics(
  category: ReusableResourceCategory | null,
  metrics: ResourceMetrics,
) {
  return {
    projectUseCount: metrics.projectUseCount,
    netLifetimeCost: metrics.netLifetimeCost,
    costPerProjectUse: category === "tools" ? metrics.costPerProjectUse : null,
    grossLifetimeAcquisitionCost:
      category === "tools" ? metrics.grossLifetimeAcquisitionCost : null,
  };
}

async function loadProjectSoftwareWindowCosts(
  dbc: DrizzleClient,
  productIds: ProductId[],
  context: ResourceWindowContext | null,
): Promise<Map<ProductId, number>> {
  const result = new Map<ProductId, number>();
  if (productIds.length === 0 || context === null) return result;

  const rows = await dbc
    .select({
      productId: expense.productId,
      netCost: sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(Number),
    })
    .from(expense)
    .where(
      and(
        inArray(expense.productId, productIds),
        eq(expense.lineKind, "principal"),
        eq(expense.future, false),
        isNotNull(expense.cost),
        gte(expense.date, context.sharedWindow.startDate),
        lte(expense.date, context.sharedWindow.endDate),
        or(
          isNull(effectiveExpenseProject),
          notInArray(effectiveExpenseProject, [...context.excludedProjectIds]),
        ),
        notDeleted(expense),
      ),
    )
    .groupBy(expense.productId);

  for (const row of rows) {
    if (row.productId) result.set(row.productId, row.netCost);
  }
  return result;
}

/** Shared `purchased_here` definition for suggestions, matrix, and ownership. */
export async function loadProjectToolPurchaseCosts(
  dbc: DrizzleClient,
  projectIds: ProjectId[],
  productIds: ProductId[],
): Promise<Map<ProjectId, Map<ProductId, number>>> {
  const result = new Map<ProjectId, Map<ProductId, number>>();
  if (projectIds.length === 0 || productIds.length === 0) return result;
  const rows = await dbc
    .select({
      projectId: effectiveExpenseProject,
      productId: expense.productId,
      cost: sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(Number),
    })
    .from(expense)
    .where(
      and(
        inArray(effectiveExpenseProject, projectIds),
        inArray(expense.productId, productIds),
        eq(expense.future, false),
        eq(expense.lineKind, "principal"),
        eq(expense.costType, "tools"),
        gt(expense.cost, 0),
        notDeleted(expense),
      ),
    )
    .groupBy(effectiveExpenseProject, expense.productId);
  for (const row of rows) {
    if (!row.projectId || !row.productId) continue;
    const perProject = result.get(row.projectId) ?? new Map();
    perProject.set(row.productId, row.cost);
    result.set(row.projectId, perProject);
  }
  return result;
}

async function loadProjectPurchaseCosts(
  dbc: DrizzleClient,
  projectId: ProjectId,
  productIds: ProductId[],
): Promise<Map<ProductId, number>> {
  const byProject = await loadProjectToolPurchaseCosts(
    dbc,
    [projectId],
    productIds,
  );
  return byProject.get(projectId) ?? new Map();
}

async function loadProductPurchaseCostsByProject(
  dbc: DrizzleClient,
  productId: ProductId,
  projectIds: ProjectId[],
): Promise<Map<ProjectId, number>> {
  const result = new Map<ProjectId, number>();
  if (projectIds.length === 0) return result;
  const rows = await dbc
    .select({
      projectId: effectiveExpenseProject,
      cost: sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(Number),
    })
    .from(expense)
    .where(
      and(
        eq(expense.productId, productId),
        inArray(effectiveExpenseProject, projectIds),
        eq(expense.future, false),
        eq(expense.lineKind, "principal"),
        eq(expense.costType, "tools"),
        gt(expense.cost, 0),
        notDeleted(expense),
      ),
    )
    .groupBy(effectiveExpenseProject);
  for (const row of rows) {
    if (row.projectId) result.set(row.projectId, row.cost);
  }
  return result;
}

async function listProjectResources(
  db: Database,
  projectId: ProjectId,
  options: ResourceReadOptions = {},
): Promise<ProjectResourceOut[]> {
  const dbc = getDb(db);
  const rows = await dbc
    .select({
      productId: projectToolUsage.productId,
      productCode: product.shortcode,
      productName: product.name,
      manufacturer: product.manufacturer,
      category: reusableCategorySql(),
      attachedAt: projectToolUsage.createdAt,
    })
    .from(projectToolUsage)
    .innerJoin(
      product,
      and(eq(product.id, projectToolUsage.productId), notDeleted(product)),
    )
    .where(
      and(
        eq(projectToolUsage.projectId, projectId),
        categoryFeatureInSql(
          sql`${product.categoryId}`,
          projectResourceFeatures,
        ),
        notDeleted(projectToolUsage),
      ),
    )
    .orderBy(asc(product.name));

  const reusableRows = rows.filter(
    (
      row,
    ): row is (typeof rows)[number] & {
      category: ReusableResourceCategory;
    } => row.category === "tools" || row.category === "software",
  );
  const productIds = reusableRows.map((row) => row.productId);
  const toolIds = reusableRows
    .filter((row) => row.category === "tools")
    .map((row) => row.productId);
  const softwareIds = reusableRows
    .filter((row) => row.category === "software")
    .map((row) => row.productId);
  const [metrics, purchaseCosts, loadedWindows, coverImageUrls] =
    await Promise.all([
      loadResourceMetrics(dbc, productIds),
      loadProjectPurchaseCosts(dbc, projectId, toolIds),
      softwareIds.length > 0 ? loadProjectDateWindows(db) : null,
      getProductCoverImageUrlsByProductIds(db, productIds),
    ]);
  const windowContext = loadedWindows
    ? (buildResourceWindowContexts(
        loadedWindows,
        [projectId],
        options.today ?? householdLocalDate(),
      ).get(projectId) ?? null)
    : null;
  const softwareWindowCosts = await loadProjectSoftwareWindowCosts(
    dbc,
    softwareIds,
    windowContext,
  );

  return reusableRows.map((row) => {
    const category = row.category;
    return {
      productId: parseShortcodeFor("product", row.productCode),
      productName: row.productName,
      manufacturer: row.manufacturer,
      category,
      coverImageUrl: coverImageUrls.get(row.productId) ?? null,
      attachedAt: row.attachedAt,
      projectPurchaseCost:
        category === "tools" ? (purchaseCosts.get(row.productId) ?? 0) : null,
      sharedWindow:
        category === "software" && windowContext !== null
          ? {
              ...windowContext.sharedWindow,
              netCost: softwareWindowCosts.get(row.productId) ?? 0,
            }
          : null,
      ...publicResourceMetrics(
        category,
        metrics.get(row.productId) ?? EMPTY_METRICS,
      ),
    };
  });
}

async function liveResourceCodes(
  dbc: DrizzleClient,
  projectId: ProjectId,
): Promise<string[]> {
  const rows = await dbc
    .select({ shortcode: product.shortcode })
    .from(projectToolUsage)
    .innerJoin(product, eq(product.id, projectToolUsage.productId))
    .where(
      and(
        eq(projectToolUsage.projectId, projectId),
        notDeleted(projectToolUsage),
        notDeleted(product),
      ),
    )
    .orderBy(asc(product.shortcode));
  return rows.map((row) => row.shortcode);
}

type UsagePair = { projectId: ProjectId; productId: ProductId };

/**
 * Refuse usage edges for tools we did not own while the project ran. Every
 * attach path funnels through here — the single setter, the project-keyed bulk
 * attach (which MCP's `attach_entity` calls for a PRJ- parent), and the product-keyed
 * set replacement.
 *
 * Three deliberate exemptions, and all of them matter:
 *
 *  - **Pairs that already have a live edge pass.** This blocks NEW conflicts;
 *    it never blocks preserving an old one. Without it the four live bad rows
 *    this rule exists to surface would make the "Edit projects" panel
 *    permanently unsavable, and detaching them impossible.
 *  - **Pairs with tool spend charged to that project pass** — the
 *    `purchased_here` exemption the two read lanes already apply. A purchase
 *    Expense on the project is direct evidence we owned the tool for it, and it
 *    outranks a window an explicit override may have narrowed. Without this the
 *    grid offers a `purchased_here` / `purchase_evidence` cell as its primary
 *    confirm action and the server refuses every click (live example: Fiskars
 *    Hedge Shears, $19.98 charged to "Spring 26 Garden Refresh", acquired
 *    2026-05-16 against an explicit 2026-04-14 end).
 *  - **Detach is never checked.** `used: false` and `detachProjectResources`
 *    don't call this at all.
 *
 * TRANSACTION BOUNDARY: this runs OUTSIDE `withTransaction`. It
 * fans its six reads out with `Promise.all`, and pg refuses a second query on a
 * client that is already executing one — so pulling it under a transaction to
 * share it with `assertUsagePair` would break it. It also needs the opaque
 * `Database` for `loadProjectDateWindows`, which a transaction client is not.
 * Safe outside: it reads only ledger history, which a concurrent usage write
 * cannot move.
 */
interface ToolTimelineConflictRow {
  projectId: ProjectId;
  productId: ProductId;
  message: string;
}

async function findToolTimelineConflicts(
  db: Database,
  pairs: UsagePair[],
  options: ResourceReadOptions = {},
): Promise<ToolTimelineConflictRow[]> {
  if (pairs.length === 0) return [];
  const dbc = getDb(db);
  const today = options.today ?? householdLocalDate();
  const projectIds = uniq(pairs.map((pair) => pair.projectId));
  const productIds = uniq(pairs.map((pair) => pair.productId));

  const [
    loadedWindows,
    ownership,
    projectRows,
    productRows,
    existingRows,
    purchaseCosts,
  ] = await Promise.all([
    loadProjectDateWindows(db),
    loadProductOwnershipTimelines(dbc, productIds, { today }),
    dbc
      .select({ id: project.id, name: project.name })
      .from(project)
      .where(and(inArray(project.id, projectIds), notDeleted(project))),
    dbc
      .select({ id: product.id, name: product.name })
      .from(product)
      .where(and(inArray(product.id, productIds), notDeleted(product))),
    dbc
      .select({
        projectId: projectToolUsage.projectId,
        productId: projectToolUsage.productId,
      })
      .from(projectToolUsage)
      .where(
        and(
          inArray(projectToolUsage.projectId, projectIds),
          inArray(projectToolUsage.productId, productIds),
          notDeleted(projectToolUsage),
        ),
      ),
    loadProjectToolPurchaseCosts(dbc, projectIds, productIds),
  ]);

  const gates = buildTimelineGates(loadedWindows, projectIds);
  const projectNameById = new Map(projectRows.map((row) => [row.id, row.name]));
  const productNameById = new Map(productRows.map((row) => [row.id, row.name]));
  const alreadyLive = new Set(
    existingRows.map((row) => `${row.projectId}:${row.productId}`),
  );

  const conflicts: ToolTimelineConflictRow[] = [];
  for (const { projectId, productId } of pairs) {
    if (alreadyLive.has(`${projectId}:${productId}`)) continue;
    if ((purchaseCosts.get(projectId)?.get(productId) ?? 0) > 0) continue;
    const gate = gates.get(projectId);
    if (!gate) continue;
    const conflict = toolTimelineConflict(
      ownership.get(productId) ?? UNKNOWN_OWNERSHIP,
      gate.window,
      { isLive: gate.isLive, today },
    );
    if (!conflict) continue;
    conflicts.push({
      projectId,
      productId,
      message: describeToolTimelineConflict(conflict, {
        toolName: productNameById.get(productId) ?? "That tool",
        projectName: projectNameById.get(projectId) ?? "this project",
      }),
    });
  }
  return conflicts;
}

async function assertNoTimelineConflict(
  db: Database,
  pairs: UsagePair[],
  options: ResourceReadOptions = {},
): Promise<void> {
  const [conflict] = await findToolTimelineConflicts(db, pairs, options);
  if (conflict) {
    throw createAppError("TOOL_TIMELINE_CONFLICT", conflict.message);
  }
}

async function liveResourceProductIds(
  dbc: DrizzleClient | DrizzleTransaction,
  projectId: ProjectId,
  productIds: readonly ProductId[],
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const rows = await dbc
    .select({ productId: projectToolUsage.productId })
    .from(projectToolUsage)
    .where(
      and(
        eq(projectToolUsage.projectId, projectId),
        inArray(projectToolUsage.productId, [...productIds]),
        notDeleted(projectToolUsage),
      ),
    );
  return new Set(rows.map((row) => row.productId));
}

/** Separates missing products from live products with an ineligible category. */
async function preflightAttachProjectResources(
  dbc: DrizzleClient | DrizzleTransaction,
  projectId: ProjectId,
  productIds: readonly ProductId[],
): Promise<RelationPreflight> {
  const requested = uniq([...productIds]);
  const { rows, codeById } = await loadRelationProducts(dbc, requested);
  const liveProject = await dbc.query.project.findFirst({
    where: and(eq(project.id, projectId), notDeleted(project)),
    columns: { id: true },
  });
  const alreadyLive = await liveResourceProductIds(dbc, projectId, requested);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    ...emptyPreflight(),
    requested,
    parentMissing: !liveProject,
    missing: requested.filter((id) => !byId.get(id)?.live),
    ineligible: requested.filter((id) => {
      const row = byId.get(id);
      return !!row?.live && !row.reusable;
    }),
    alreadySatisfied: requested.filter((id) => alreadyLive.has(id)),
    codeById,
  };
}

async function preflightDetachProjectResources(
  dbc: DrizzleClient | DrizzleTransaction,
  projectId: ProjectId,
  productIds: readonly ProductId[],
): Promise<RelationPreflight> {
  const requested = uniq([...productIds]);
  const { codeById } = await loadRelationProducts(dbc, requested);
  const alreadyLive = await liveResourceProductIds(dbc, projectId, requested);
  return {
    ...emptyPreflight(),
    requested,
    alreadySatisfied: requested.filter((id) => !alreadyLive.has(id)),
    codeById,
  };
}

function assertResourcesAttachable(
  projectId: ProjectId,
  pre: RelationPreflight,
): void {
  if (pre.parentMissing) {
    throw createAppError("PROJECT_NOT_FOUND", `Project ${projectId} not found`);
  }
  if (pre.missing.length > 0) {
    throwRelationRefusal({
      reason: "PRODUCT_NOT_FOUND",
      ids: pre.missing,
      codeById: pre.codeById,
      message: (codes) =>
        `Every attached Product must exist and be live. Not live: ${codes}.`,
      items: [
        relationImpact({
          code: "block-relation-target-not-live",
          label: "products that are not live",
          description:
            "A Product named here does not exist or has been deleted.",
          ids: pre.missing,
        }),
      ],
    });
  }
  if (pre.ineligible.length > 0) {
    throwRelationRefusal({
      reason: "PRODUCT_CATEGORY_INELIGIBLE",
      ids: pre.ineligible,
      codeById: pre.codeById,
      message: (codes) =>
        `A project resource must be in a category that allows project resources (${projectResourceFeatureLabels}). Wrong category: ${codes}. Change the product's category, or attach a different Product — these exist and are live.`,
      items: [
        relationImpact({
          code: "block-product-category-ineligible",
          label: "products of the wrong category",
          description: `The Product is live, but only a category that allows project resources (${projectResourceFeatureLabels}) may be recorded as a project resource.`,
          ids: pre.ineligible,
        }),
      ],
    });
  }
}

const PROJECT_RESOURCE_EDGE = {
  edgeKey: "ProjectToolUsage.productId",
  label: "project resource uses",
} as const;

async function previewAttachProjectResources(
  db: Database,
  projectId: ProjectId,
  productIds: readonly ProductId[],
  options: ResourceReadOptions = {},
): Promise<RelationPlan> {
  const uniqueProductIds = uniq([...productIds]);
  const conflicts = await findToolTimelineConflicts(
    db,
    uniqueProductIds.map((productId) => ({ projectId, productId })),
    options,
  );
  const pre = await preflightAttachProjectResources(
    getDb(db),
    projectId,
    uniqueProductIds,
  );
  const plan = planRelationAttach(pre, {
    ...PROJECT_RESOURCE_EDGE,
    description: "Resource uses this attach would record.",
  });
  const timelineBlocker = relationImpact({
    code: "block-tool-timeline-conflict",
    label: "tools we did not own during the project",
    description: conflicts[0]
      ? conflicts[0].message
      : "The tool's ownership window does not cover the project.",
    ids: conflicts.map((conflict) => conflict.productId),
  });
  return {
    blockers: timelineBlocker
      ? [...plan.blockers, timelineBlocker]
      : plan.blockers,
    changes: timelineBlocker
      ? plan.changes.map((item) => withoutTargets(item, conflicts))
      : plan.changes,
  };
}

function withoutTargets(
  item: ImpactItem,
  conflicts: ToolTimelineConflictRow[],
): ImpactItem {
  const blocked = new Set<string>(conflicts.map((c) => c.productId));
  const byTargetId = Object.fromEntries(
    Object.entries(item.byTargetId).filter(([id]) => !blocked.has(id)),
  );
  return {
    ...item,
    byTargetId,
    total: Object.keys(byTargetId).length,
  };
}

export async function attachProjectResources(
  db: Database,
  projectId: ProjectId,
  productIds: ProductId[],
  actor: ActorContext,
  options: ResourceReadOptions = {},
): Promise<RelationMutationOut> {
  const uniqueProductIds = uniq(productIds);
  // Outside the transaction, and it has to be — see the boundary note on
  // `findToolTimelineConflicts`.
  await assertNoTimelineConflict(
    db,
    uniqueProductIds.map((productId) => ({ projectId, productId })),
    options,
  );
  return withTransaction(db, async (tx) => {
    // On `tx`: these checks and the insert below must see one snapshot.
    const pre = await preflightAttachProjectResources(
      tx,
      projectId,
      uniqueProductIds,
    );
    assertResourcesAttachable(projectId, pre);

    const before = await liveResourceCodes(tx, projectId);
    const inserted = await tx
      .insert(projectToolUsage)
      .values(uniqueProductIds.map((productId) => ({ projectId, productId })))
      .onConflictDoNothing()
      .returning({ id: projectToolUsage.id });
    const after = await liveResourceCodes(tx, projectId);

    if (inserted.length > 0) {
      await logAuditEntry(tx, actor, {
        entityType: "project",
        entityId: projectId,
        action: "update",
        changes: { usedResourceIds: { from: before, to: after } },
      });
    }
    return {
      changed: inserted.length,
      attached: after.length,
      alreadySatisfied: uniqueProductIds.length - inserted.length,
    };
  });
}

export const projectResourcesRelationAdapter = {
  async list(db, ownerShortcode) {
    return listProjectResources(
      db,
      await resolveOrThrow(db, "project", ownerShortcode),
    );
  },
  async preview(db, action, ownerId, targetIds) {
    const projectId = parseEntityId("project", ownerId);
    const productIds = targetIds.map((id) => parseEntityId("product", id));
    return action === "attach"
      ? previewAttachProjectResources(db, projectId, productIds)
      : planRelationDetach(
          await preflightDetachProjectResources(
            getDb(db),
            projectId,
            productIds,
          ),
          {
            ...PROJECT_RESOURCE_EDGE,
            description: "Resource uses this detach would remove.",
          },
        );
  },
  async execute(ctx, action, ownerShortcode, items) {
    const projectId = await resolveOrThrow(ctx.db, "project", ownerShortcode);
    const productIds = await resolveAllOrThrow(
      ctx.db,
      "product",
      items.map(({ id }) => id),
    );
    return action === "attach"
      ? attachProjectResources(ctx.db, projectId, productIds, ctx.actorContext)
      : detachProjectResources(ctx.db, projectId, productIds, ctx.actorContext);
  },
} satisfies EntityRelationMutationAdapter<{ id: string }, ProjectResourceOut>;

export async function detachProjectResources(
  db: Database,
  projectId: ProjectId,
  productIds: ProductId[],
  actor: ActorContext,
): Promise<RelationMutationOut> {
  const uniqueProductIds = uniq(productIds);
  return withTransaction(db, async (tx) => {
    const before = await liveResourceCodes(tx, projectId);
    const removed = await tx
      .update(projectToolUsage)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(projectToolUsage.projectId, projectId),
          inArray(projectToolUsage.productId, uniqueProductIds),
          notDeleted(projectToolUsage),
        ),
      )
      .returning({ id: projectToolUsage.id });
    const after = await liveResourceCodes(tx, projectId);

    if (removed.length > 0) {
      await logAuditEntry(tx, actor, {
        entityType: "project",
        entityId: projectId,
        action: "update",
        changes: { usedResourceIds: { from: before, to: after } },
      });
    }
    return {
      changed: removed.length,
      attached: after.length,
      alreadySatisfied: uniqueProductIds.length - removed.length,
    };
  });
}

/**
 * Repoints existing usage history. Destination category is checked, but the
 * ownership timeline is not: this corrects history rather than asserting use.
 */
export async function repointProjectUses(
  db: Database,
  args: {
    fromProductId: ProductId;
    toProductId: ProductId;
    projectIds?: ProjectId[];
  },
  actor: ActorContext,
): Promise<{ repointed: number; alreadyPresent: number }> {
  const { fromProductId, toProductId, projectIds } = args;
  if (fromProductId === toProductId) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Source and destination products must be different",
    );
  }

  return withTransaction(db, async (tx) => {
    await assertReusableResource(tx, toProductId, "The destination Product");

    const rows = await tx.query.projectToolUsage.findMany({
      where: and(
        inArray(projectToolUsage.productId, [fromProductId, toProductId]),
        projectIds?.length
          ? inArray(projectToolUsage.projectId, projectIds)
          : undefined,
        notDeleted(projectToolUsage),
      ),
      columns: { id: true, productId: true, projectId: true },
    });
    const movable = rows.filter((row) => row.productId === fromProductId);
    if (movable.length === 0) return { repointed: 0, alreadyPresent: 0 };

    // `foldAssociation`, not a bare `UPDATE ... SET productId`: the partial
    // unique index `(projectId, productId)` means a project that already
    // records the destination would abort the transaction. This is the same
    // helper `mergeProducts` uses for this exact table.
    const repointed = await foldAssociation(tx, {
      table: projectToolUsage,
      column: "productId",
      repointValues: (productId) => ({ productId }),
      softDeleteValues: (deletedAt) => ({ deletedAt }),
      rows,
      keepId: toProductId,
      slotKey: (row) => row.projectId,
      now: new Date(),
    });

    // Audit BOTH sides. A project-keyed diff would record that the destination
    // gained uses without recording that the source lost them, which is exactly
    // the half-story the detach-without-attach failure told.
    for (const entityId of [fromProductId, toProductId]) {
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId,
        action: "update",
        changes: {
          usedOnProjectIds: {
            from: await liveProjectCodes(tx, entityId, rows),
            to: await liveProjectCodes(tx, entityId),
          },
        },
      });
    }

    return { repointed, alreadyPresent: movable.length - repointed };
  });
}

async function liveProjectCodes(
  tx: DrizzleClient,
  productId: ProductId,
  before?: ReadonlyArray<{ productId: ProductId; projectId: ProjectId }>,
): Promise<string[]> {
  if (before) {
    const projectIds = before
      .filter((row) => row.productId === productId)
      .map((row) => row.projectId);
    if (projectIds.length === 0) return [];
    const rows = await tx.query.project.findMany({
      where: inArray(project.id, projectIds),
      columns: { shortcode: true },
    });
    return rows.map((row) => row.shortcode).sort();
  }
  const rows = await tx
    .select({ shortcode: project.shortcode })
    .from(projectToolUsage)
    .innerJoin(project, eq(project.id, projectToolUsage.projectId))
    .where(
      and(
        eq(projectToolUsage.productId, productId),
        notDeleted(projectToolUsage),
      ),
    );
  return rows.map((row) => row.shortcode).sort();
}

/** Require a live reusable resource and preserve distinct failure reasons. */
async function assertReusableResource(
  dbc: DrizzleTransaction,
  productId: ProductId,
  role: string,
): Promise<{ shortcode: string }> {
  const row = await dbc.query.product.findFirst({
    where: and(eq(product.id, productId), notDeleted(product)),
    columns: { shortcode: true, categoryId: true },
  });
  if (!row) {
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      `${role} must exist and be live.`,
    );
  }
  await assertReusableCategory(dbc, productId, row);
  return { shortcode: row.shortcode };
}

async function assertReusableCategory(
  db: Database | DrizzleTransaction,
  productId: ProductId,
  row: {
    shortcode: string;
    categoryId: (typeof product.$inferSelect)["categoryId"];
  },
): Promise<void> {
  const category = await getCategoryFeature(db, row.categoryId);
  if (isProjectResourceFeature(category)) return;
  throwRelationRefusal({
    reason: "PRODUCT_CATEGORY_INELIGIBLE",
    ids: [productId],
    codeById: new Map([[productId, row.shortcode]]),
    message: (codes) =>
      `A project resource must be in a category that allows project resources (${projectResourceFeatureLabels}). ${codes} is ineligible — change the product's category, or use a different Product.`,
    items: [
      relationImpact({
        code: "block-product-category-ineligible",
        label: "products of the wrong category",
        description: `The Product is live, but only a category that allows project resources (${projectResourceFeatureLabels}) may be recorded as a project resource.`,
        ids: [productId],
      }),
    ],
  });
}

async function assertUsagePair(
  tx: DrizzleTransaction,
  projectId: ProjectId,
  productId: ProductId,
): Promise<{ productCode: string }> {
  const [liveProject, liveProduct] = await Promise.all([
    tx.query.project.findFirst({
      where: and(eq(project.id, projectId), notDeleted(project)),
      columns: { id: true },
    }),
    tx.query.product.findFirst({
      where: and(eq(product.id, productId), notDeleted(product)),
      columns: { shortcode: true, categoryId: true },
    }),
  ]);
  if (!liveProject) {
    throw createAppError("PROJECT_NOT_FOUND", `Project ${projectId} not found`);
  }
  if (!liveProduct) {
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      "A used Product must exist and be live.",
    );
  }
  await assertReusableCategory(tx, productId, liveProduct);
  return { productCode: liveProduct.shortcode };
}

/**
 * Set one `(project, product)` usage edge to `used`. Idempotent: re-issuing the
 * current state writes nothing and logs nothing, which is what makes it safe
 * behind a grid of checkboxes where optimistic mutations can land out of order.
 *
 * The audit entry names the pair (`usedResource`) rather than diffing the
 * project's whole shortcode array the way the bulk paths do — that payload
 * grows with the project and forces a reader to diff two lists to learn which
 * one cell moved.
 *
 */
export async function setProjectToolUsage(
  db: Database,
  projectId: ProjectId,
  productId: ProductId,
  used: boolean,
  actor: ActorContext,
  options: ResourceReadOptions = {},
): Promise<{ changed: boolean }> {
  // Attach only. Clearing a checkbox must stay possible on a conflicting edge.
  if (used) {
    await assertNoTimelineConflict(db, [{ projectId, productId }], options);
  }
  return withTransaction(db, async (tx) => {
    const { productCode } = await assertUsagePair(tx, projectId, productId);

    const existing = await tx.query.projectToolUsage.findFirst({
      where: and(
        eq(projectToolUsage.projectId, projectId),
        eq(projectToolUsage.productId, productId),
        notDeleted(projectToolUsage),
      ),
      columns: { id: true },
    });

    let changed = false;
    if (used && !existing) {
      // `onConflictDoNothing` against the PARTIAL unique index (live rows only):
      // re-attaching after a soft delete inserts a NEW physical row rather than
      // conflicting, which is intended — `attachedAt` should reflect the current
      // attachment. Making that index unconditional would break this insert.
      await tx
        .insert(projectToolUsage)
        .values({ projectId, productId })
        .onConflictDoNothing();
      changed = true;
    } else if (!used && existing) {
      await tx
        .update(projectToolUsage)
        .set({ deletedAt: new Date() })
        .where(eq(projectToolUsage.id, existing.id));
      changed = true;
    }

    if (changed) {
      await logAuditEntry(tx, actor, {
        entityType: "project",
        entityId: projectId,
        action: "update",
        changes: {
          usedResource: used
            ? { from: null, to: productCode }
            : { from: productCode, to: null },
        },
      });
    }

    return { changed };
  });
}

/** Atomically replace one product's project-use set; unchanged rows stay untouched. */
export async function setProductProjectUses(
  db: Database,
  productId: ProductId,
  projectIds: ProjectId[],
  actor: ActorContext,
  options: ResourceReadOptions = {},
): Promise<{ changed: number }> {
  const desired = uniq(projectIds);
  await assertNoTimelineConflict(
    db,
    desired.map((projectId) => ({ projectId, productId })),
    options,
  );
  return withTransaction(db, async (tx) => {
    await assertReusableResource(tx, productId, "A used Product");

    const liveProjects =
      desired.length === 0
        ? []
        : await tx.query.project.findMany({
            where: and(inArray(project.id, desired), notDeleted(project)),
            columns: { id: true, shortcode: true },
          });
    if (liveProjects.length !== desired.length) {
      throw createAppError(
        "PROJECT_NOT_FOUND",
        "Every Project a tool is used on must exist and be live.",
      );
    }
    const codeByProject = new Map(
      liveProjects.map((row) => [row.id, row.shortcode]),
    );

    const currentRows = await tx
      .select({
        projectId: projectToolUsage.projectId,
        shortcode: project.shortcode,
      })
      .from(projectToolUsage)
      .innerJoin(
        project,
        and(eq(project.id, projectToolUsage.projectId), notDeleted(project)),
      )
      .where(
        and(
          eq(projectToolUsage.productId, productId),
          notDeleted(projectToolUsage),
        ),
      );
    const current = new Set(currentRows.map((row) => row.projectId));
    const desiredSet = new Set(desired);

    const additions = desired.filter((id) => !current.has(id));
    const removals = currentRows
      .filter((row) => !desiredSet.has(row.projectId))
      .map((row) => row.projectId);

    if (removals.length > 0) {
      await tx
        .update(projectToolUsage)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(projectToolUsage.productId, productId),
            inArray(projectToolUsage.projectId, removals),
            notDeleted(projectToolUsage),
          ),
        );
    }
    if (additions.length > 0) {
      await tx
        .insert(projectToolUsage)
        .values(additions.map((projectId) => ({ projectId, productId })))
        .onConflictDoNothing();
    }

    const changed = additions.length + removals.length;
    if (changed > 0) {
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: productId,
        action: "update",
        changes: {
          usedOnProjectIds: {
            from: currentRows.map((row) => row.shortcode).sort(),
            to: desired
              .flatMap((id) => {
                const code = codeByProject.get(id);
                return code ? [code] : [];
              })
              .sort(),
          },
        },
      });
    }
    return { changed };
  });
}

type ProjectTradeSignal = {
  trade: Trade;
  taskCount: number;
  expenseCount: number;
  grossSpend: number;
};

export async function suggestProjectTools(
  db: Database,
  projectId: ProjectId,
  options: ResourceReadOptions = {},
): Promise<ProjectToolSuggestionsOut> {
  const dbc = getDb(db);
  const today = options.today ?? householdLocalDate();
  const [
    attachedRows,
    taskTrades,
    expenseTrades,
    directRows,
    inventoryRows,
    loadedWindows,
  ] = await Promise.all([
    dbc
      .select({ productId: projectToolUsage.productId })
      .from(projectToolUsage)
      .where(
        and(
          eq(projectToolUsage.projectId, projectId),
          notDeleted(projectToolUsage),
        ),
      ),
    dbc
      .select({ trade: effectiveTaskTrade, taskCount: count() })
      .from(task)
      .where(
        and(
          eq(effectiveTaskProject, projectId),
          ne(effectiveTaskTrade, "planning"),
          ne(effectiveTaskTrade, "other"),
          notDeleted(task),
        ),
      )
      .groupBy(effectiveTaskTrade),
    dbc
      .select({
        trade: effectiveExpenseTrade,
        expenseCount: count(),
        grossSpend: sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(
          Number,
        ),
      })
      .from(expense)
      .where(
        and(
          eq(effectiveExpenseProject, projectId),
          eq(expense.lineKind, "principal"),
          eq(expense.future, false),
          gt(expense.cost, 0),
          ne(effectiveExpenseTrade, "planning"),
          ne(effectiveExpenseTrade, "other"),
          notDeleted(expense),
        ),
      )
      .groupBy(effectiveExpenseTrade),
    dbc
      .select({
        productId: product.id,
        productCode: product.shortcode,
        productName: product.name,
        manufacturer: product.manufacturer,
        projectPurchaseCost:
          sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(Number),
      })
      .from(expense)
      .innerJoin(
        product,
        and(eq(product.id, expense.productId), notDeleted(product)),
      )
      .where(
        and(
          eq(effectiveExpenseProject, projectId),
          eq(expense.lineKind, "principal"),
          eq(expense.future, false),
          eq(expense.costType, "tools"),
          gt(expense.cost, 0),
          categoryFeatureSql(sql`${product.categoryId}`, "tools"),
          notDeleted(expense),
        ),
      )
      .groupBy(
        product.id,
        product.shortcode,
        product.name,
        product.manufacturer,
      ),
    // includes-installed: a bench-mounted vise is installed and still a tool
    // you own — this feeds "which tools are available", not a count/browse.
    dbc
      .selectDistinct({ productId: inventoryEntry.productId })
      .from(inventoryEntry)
      .innerJoin(
        product,
        and(eq(product.id, inventoryEntry.productId), notDeleted(product)),
      )
      .where(
        and(
          categoryFeatureSql(sql`${product.categoryId}`, "tools"),
          notDeleted(inventoryEntry),
        ),
      ),
    loadProjectDateWindows(db),
  ]);

  const timelineGate = buildTimelineGates(loadedWindows, [projectId]).get(
    projectId,
  );
  const attached = new Set(attachedRows.map((row) => row.productId));
  const inventoried = new Set(inventoryRows.map((row) => row.productId));
  const taskCountByTrade = new Map(
    taskTrades.flatMap((row) =>
      row.trade ? [[row.trade, Number(row.taskCount)] as const] : [],
    ),
  );
  const expenseByTrade = new Map(
    expenseTrades.flatMap((row) =>
      row.trade
        ? [
            [
              row.trade,
              {
                expenseCount: Number(row.expenseCount),
                grossSpend: row.grossSpend,
              },
            ] as const,
          ]
        : [],
    ),
  );
  const trades = uniq([
    ...taskTrades.flatMap((row) => (row.trade ? [row.trade] : [])),
    ...expenseTrades.flatMap((row) => (row.trade ? [row.trade] : [])),
  ])
    .map((trade): ProjectTradeSignal => ({
      trade,
      taskCount: taskCountByTrade.get(trade) ?? 0,
      expenseCount: expenseByTrade.get(trade)?.expenseCount ?? 0,
      grossSpend: expenseByTrade.get(trade)?.grossSpend ?? 0,
    }))
    .sort(
      (a, b) =>
        b.taskCount - a.taskCount ||
        b.expenseCount - a.expenseCount ||
        b.grossSpend - a.grossSpend ||
        a.trade.localeCompare(b.trade),
    );

  const tradeRows =
    trades.length === 0
      ? []
      : await dbc
          .select({
            productId: product.id,
            productCode: product.shortcode,
            productName: product.name,
            manufacturer: product.manufacturer,
            trade: effectiveExpenseTrade,
            matchingExpenseCount: count(),
          })
          .from(expense)
          .innerJoin(
            product,
            and(eq(product.id, expense.productId), notDeleted(product)),
          )
          .where(
            and(
              inArray(
                effectiveExpenseTrade,
                trades.map((signal) => signal.trade),
              ),
              eq(expense.future, false),
              eq(expense.lineKind, "principal"),
              eq(expense.costType, "tools"),
              gt(expense.cost, 0),
              categoryFeatureSql(sql`${product.categoryId}`, "tools"),
              notDeleted(expense),
            ),
          )
          .groupBy(
            product.id,
            product.shortcode,
            product.name,
            product.manufacturer,
            effectiveExpenseTrade,
          );

  const candidateProductIds = uniq([
    ...directRows.map((row) => row.productId),
    ...tradeRows.map((row) => row.productId),
  ]);
  const [metrics, ownership, coverImageUrls] = await Promise.all([
    loadResourceMetrics(dbc, candidateProductIds),
    loadProductOwnershipTimelines(dbc, candidateProductIds, { today }),
    getProductCoverImageUrlsByProductIds(db, candidateProductIds),
  ]);

  /**
   * Did we own this tool while the project was running? Only the inferred lane
   * asks: a `purchased_here` tool's own purchase Expense is charged to this
   * project, which is ledger fact that an explicit window override does not
   * make false.
   */
  const timelineConflictFor = (productId: ProductId) =>
    timelineGate
      ? toolTimelineConflict(
          ownership.get(productId) ?? UNKNOWN_OWNERSHIP,
          timelineGate.window,
          { isLive: timelineGate.isLive, today },
        )
      : null;

  const directSuggestions: ProjectToolSuggestionOut[] = directRows
    .filter(
      (row) =>
        !attached.has(row.productId) &&
        row.projectPurchaseCost >= EXPENSIVE_TOOL_THRESHOLD,
    )
    .map((row) => ({
      productId: parseShortcodeFor("product", row.productCode),
      productName: row.productName,
      manufacturer: row.manufacturer,
      coverImageUrl: coverImageUrls.get(row.productId) ?? null,
      lane: "purchased_here" as const,
      matchedTrade: null,
      // Not `formatCurrency`: that helper lives in `~/lib/utils`, a
      // client-side module with no existing server import (grep confirms
      // zero) — see the same note in repo/project/attention.ts.
      reasons: [`Bought here · $${Math.round(row.projectPurchaseCost)}`],
      isInventoried: inventoried.has(row.productId),
      projectPurchaseCost: row.projectPurchaseCost,
      matchingExpenseCount: 0,
      ...(metrics.get(row.productId) ?? EMPTY_METRICS),
    }))
    .sort(
      (a, b) =>
        b.projectPurchaseCost - a.projectPurchaseCost ||
        a.productName.localeCompare(b.productName),
    );
  const expensiveDirectIds = new Set(
    directRows
      .filter((row) => row.projectPurchaseCost >= EXPENSIVE_TOOL_THRESHOLD)
      .map((row) => row.productId),
  );

  const tradeRowsByTrade = new Map<Trade, typeof tradeRows>();
  for (const row of tradeRows) {
    if (row.trade === null) continue;
    const current = tradeRowsByTrade.get(row.trade) ?? [];
    current.push(row);
    tradeRowsByTrade.set(row.trade, current);
  }

  const chosenTradeProductIds = new Set<ProductId>();
  // Tools that cleared every other gate and were dropped ONLY because we did
  // not own them during the project. Counted distinctly so the count reads as
  // "how many tools are hidden", not "how many (tool, trade) pairs".
  const timelineSuppressed = new Set<ProductId>();
  const tradeSuggestions: ProjectToolSuggestionOut[] = [];
  for (const signal of trades) {
    const ranked = (tradeRowsByTrade.get(signal.trade) ?? [])
      .filter((row) => {
        const toolMetrics = metrics.get(row.productId) ?? EMPTY_METRICS;
        const eligible =
          inventoried.has(row.productId) &&
          !attached.has(row.productId) &&
          !expensiveDirectIds.has(row.productId) &&
          !chosenTradeProductIds.has(row.productId) &&
          (toolMetrics.grossLifetimeAcquisitionCost >=
            EXPENSIVE_TOOL_THRESHOLD ||
            toolMetrics.projectUseCount >= REUSED_CHEAP_TOOL_PROJECTS);
        if (!eligible) return false;
        if (timelineConflictFor(row.productId) === null) return true;
        timelineSuppressed.add(row.productId);
        return false;
      })
      .sort((a, b) => {
        const aMetrics = metrics.get(a.productId) ?? EMPTY_METRICS;
        const bMetrics = metrics.get(b.productId) ?? EMPTY_METRICS;
        return (
          bMetrics.projectUseCount - aMetrics.projectUseCount ||
          Number(b.matchingExpenseCount) - Number(a.matchingExpenseCount) ||
          bMetrics.grossLifetimeAcquisitionCost -
            aMetrics.grossLifetimeAcquisitionCost ||
          a.productName.localeCompare(b.productName)
        );
      })
      .slice(0, MAX_SUGGESTIONS_PER_TRADE);

    for (const row of ranked) {
      if (tradeSuggestions.length >= MAX_TRADE_SUGGESTIONS) break;
      chosenTradeProductIds.add(row.productId);
      const toolMetrics = metrics.get(row.productId) ?? EMPTY_METRICS;
      tradeSuggestions.push({
        productId: parseShortcodeFor("product", row.productCode),
        productName: row.productName,
        manufacturer: row.manufacturer,
        coverImageUrl: coverImageUrls.get(row.productId) ?? null,
        lane: "trade_match",
        matchedTrade: row.trade,
        reasons: [
          `Historically purchased as ${row.trade}`,
          ...(toolMetrics.projectUseCount > 0
            ? [
                `Used on ${toolMetrics.projectUseCount} project${toolMetrics.projectUseCount === 1 ? "" : "s"}`,
              ]
            : []),
        ],
        isInventoried: true,
        projectPurchaseCost: 0,
        matchingExpenseCount: Number(row.matchingExpenseCount),
        ...toolMetrics,
      });
    }
    if (tradeSuggestions.length >= MAX_TRADE_SUGGESTIONS) break;
  }

  const [unlinked] = await dbc
    .select({
      count: count(),
      grossCost: sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(Number),
    })
    .from(expense)
    .where(
      and(
        eq(effectiveExpenseProject, projectId),
        isNull(expense.productId),
        eq(expense.lineKind, "principal"),
        eq(expense.future, false),
        eq(expense.costType, "tools"),
        sql`${expense.cost} >= ${EXPENSIVE_TOOL_THRESHOLD}`,
        notDeleted(expense),
      ),
    );

  return {
    items: [...directSuggestions, ...tradeSuggestions],
    purchasedHereCount: directSuggestions.length,
    tradeMatchCount: tradeSuggestions.length,
    timelineConflicts: { count: timelineSuppressed.size },
    unlinkedExpensivePurchases: {
      count: Number(unlinked?.count ?? 0),
      grossCost: unlinked?.grossCost ?? 0,
    },
  };
}

type SoftwareExpenseRow = {
  projectId: ProjectId | null;
  date: string;
  cost: number;
};

async function loadSoftwareExpenseRows(
  dbc: DrizzleClient,
  productId: ProductId,
  contexts: Map<ProjectId, ResourceWindowContext | null>,
): Promise<SoftwareExpenseRow[]> {
  const validContexts = [...contexts.values()].filter(
    (context): context is ResourceWindowContext => context !== null,
  );
  if (validContexts.length === 0) return [];

  const startDate = validContexts.reduce(
    (earliest, context) =>
      context.sharedWindow.startDate < earliest
        ? context.sharedWindow.startDate
        : earliest,
    validContexts[0]!.sharedWindow.startDate,
  );
  const endDate = validContexts.reduce(
    (latest, context) =>
      context.sharedWindow.endDate > latest
        ? context.sharedWindow.endDate
        : latest,
    validContexts[0]!.sharedWindow.endDate,
  );

  const rows = await dbc
    .select({
      projectId: effectiveExpenseProject,
      date: expense.date,
      cost: expense.cost,
    })
    .from(expense)
    .where(
      and(
        eq(expense.productId, productId),
        eq(expense.lineKind, "principal"),
        eq(expense.future, false),
        isNotNull(expense.cost),
        gte(expense.date, startDate),
        lte(expense.date, endDate),
        notDeleted(expense),
      ),
    );

  return rows.flatMap((row) =>
    row.cost === null || row.date === null
      ? []
      : [{ ...row, date: row.date, cost: row.cost }],
  );
}

function softwareSharedWindow(
  context: ResourceWindowContext | null | undefined,
  expenses: SoftwareExpenseRow[],
): ProjectSharedWindowOut | null {
  if (!context) return null;
  const netCost = expenses.reduce((total, row) => {
    const insideWindow =
      row.date >= context.sharedWindow.startDate &&
      row.date <= context.sharedWindow.endDate;
    const alreadyDirect =
      row.projectId !== null && context.excludedProjectIds.has(row.projectId);
    return insideWindow && !alreadyDirect ? total + row.cost : total;
  }, 0);
  return { ...context.sharedWindow, netCost };
}

export async function listProductProjectUses(
  db: Database,
  productId: ProductId,
  options: ResourceReadOptions = {},
): Promise<ProductProjectUsesOut> {
  const dbc = getDb(db);
  const productRow = await dbc.query.product.findFirst({
    where: and(eq(product.id, productId), notDeleted(product)),
    columns: {
      shortcode: true,
      categoryId: true,
      name: true,
      manufacturer: true,
    },
  });
  if (!productRow) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${productId} not found`);
  }
  // ProjectToolUsage is durable history. It may predate a legitimate category
  // correction, so reads must never reinterpret a live edge as nonexistent.
  // Writes continue through assertReusableResource/assertUsagePair, which keep
  // the project-resource admission policy intact.
  const category = await getCategoryFeature(db, productRow.categoryId);
  const reusableCategory = reusableBucketFor(category);

  const rows = await dbc
    .select({
      projectId: project.id,
      projectCode: project.shortcode,
      projectName: project.name,
      status: project.status,
      kind: project.kind,
      attachedAt: projectToolUsage.createdAt,
    })
    .from(projectToolUsage)
    .innerJoin(
      project,
      and(eq(project.id, projectToolUsage.projectId), notDeleted(project)),
    )
    .where(
      and(
        eq(projectToolUsage.productId, productId),
        notDeleted(projectToolUsage),
      ),
    )
    .orderBy(desc(projectToolUsage.createdAt), asc(project.name));

  const projectIds = rows.map((row) => row.projectId);
  const [metricsByProduct, purchaseCostByProject, loadedWindows] =
    await Promise.all([
      loadResourceMetrics(dbc, [productId]),
      reusableCategory === "tools"
        ? loadProductPurchaseCostsByProject(dbc, productId, projectIds)
        : new Map<ProjectId, number>(),
      reusableCategory === "software" ? loadProjectDateWindows(db) : null,
    ]);
  const metrics = metricsByProduct.get(productId) ?? EMPTY_METRICS;
  const windowContexts = loadedWindows
    ? buildResourceWindowContexts(
        loadedWindows,
        projectIds,
        options.today ?? householdLocalDate(),
      )
    : new Map<ProjectId, ResourceWindowContext | null>();
  const softwareExpenses =
    reusableCategory === "software"
      ? await loadSoftwareExpenseRows(dbc, productId, windowContexts)
      : [];

  return {
    productId: parseShortcodeFor("product", productRow.shortcode),
    productName: productRow.name,
    manufacturer: productRow.manufacturer,
    category,
    canEdit: category !== null,
    ...publicResourceMetrics(reusableCategory, metrics),
    projects: rows.map((row) => ({
      projectId: parseShortcodeFor("project", row.projectCode),
      projectName: row.projectName,
      status: row.status,
      kind: row.kind,
      projectPurchaseCost:
        reusableCategory === "tools"
          ? (purchaseCostByProject.get(row.projectId) ?? 0)
          : null,
      sharedWindow:
        reusableCategory === "software"
          ? softwareSharedWindow(
              windowContexts.get(row.projectId),
              softwareExpenses,
            )
          : null,
      attachedAt: row.attachedAt,
    })),
  };
}
