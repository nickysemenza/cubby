import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId, ProjectId } from "@cubby/schemas/identifiers";
import {
  unsafeProductShortcode,
  unsafeProjectShortcode,
} from "@cubby/schemas/identifiers";
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
import { format } from "date-fns";
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
import type { Database, DrizzleClient } from "~/server/db";
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
import { maxPlainDate } from "./helpers";
import { collectDescendantIds, loadProjectDateWindows } from "./subtree";

const EXPENSIVE_TOOL_THRESHOLD = 100;
const REUSED_CHEAP_TOOL_PROJECTS = 2;
const MAX_TRADE_SUGGESTIONS = 20;
const MAX_SUGGESTIONS_PER_TRADE = 5;

type ResourceMetrics = {
  projectUseCount: number;
  netLifetimeCost: number;
  costPerProjectUse: number | null;
  grossLifetimeAcquisitionCost: number;
};

const EMPTY_METRICS: ResourceMetrics = {
  projectUseCount: 0,
  netLifetimeCost: 0,
  costPerProjectUse: null,
  grossLifetimeAcquisitionCost: 0,
};

async function loadResourceMetrics(
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
  /** Plain date override for deterministic live-project window tests. */
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

function publicResourceMetrics(
  category: ReusableResourceCategory,
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
          isNull(expense.projectId),
          notInArray(expense.projectId, [...context.excludedProjectIds]),
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

async function loadProjectPurchaseCosts(
  dbc: DrizzleClient,
  projectId: ProjectId,
  productIds: ProductId[],
): Promise<Map<ProductId, number>> {
  const result = new Map<ProductId, number>();
  if (productIds.length === 0) return result;
  const rows = await dbc
    .select({
      productId: expense.productId,
      cost: sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(Number),
    })
    .from(expense)
    .where(
      and(
        eq(expense.projectId, projectId),
        inArray(expense.productId, productIds),
        eq(expense.future, false),
        eq(expense.lineKind, "principal"),
        eq(expense.costType, "tools"),
        gt(expense.cost, 0),
        notDeleted(expense),
      ),
    )
    .groupBy(expense.productId);
  for (const row of rows) {
    if (row.productId) result.set(row.productId, row.cost);
  }
  return result;
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
      projectId: expense.projectId,
      cost: sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(Number),
    })
    .from(expense)
    .where(
      and(
        eq(expense.productId, productId),
        inArray(expense.projectId, projectIds),
        eq(expense.future, false),
        eq(expense.lineKind, "principal"),
        eq(expense.costType, "tools"),
        gt(expense.cost, 0),
        notDeleted(expense),
      ),
    )
    .groupBy(expense.projectId);
  for (const row of rows) {
    if (row.projectId) result.set(row.projectId, row.cost);
  }
  return result;
}

export async function listProjectResources(
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
      category: product.category,
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
        notDeleted(projectToolUsage),
      ),
    )
    .orderBy(asc(product.name));

  const productIds = rows.map((row) => row.productId);
  const toolIds = rows
    .filter((row) => row.category === "tools")
    .map((row) => row.productId);
  const softwareIds = rows
    .filter((row) => row.category === "software")
    .map((row) => row.productId);
  const [metrics, purchaseCosts, loadedWindows] = await Promise.all([
    loadResourceMetrics(dbc, productIds),
    loadProjectPurchaseCosts(dbc, projectId, toolIds),
    softwareIds.length > 0 ? loadProjectDateWindows(db) : null,
  ]);
  const windowContext = loadedWindows
    ? (buildResourceWindowContexts(
        loadedWindows,
        [projectId],
        options.today ?? format(new Date(), "yyyy-MM-dd"),
      ).get(projectId) ?? null)
    : null;
  const softwareWindowCosts = await loadProjectSoftwareWindowCosts(
    dbc,
    softwareIds,
    windowContext,
  );

  return rows.map((row) => {
    if (row.category !== "tools" && row.category !== "software") {
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        `${row.productName} is no longer categorized as a reusable resource`,
      );
    }
    const category = row.category;
    return {
      productId: unsafeProductShortcode(row.productCode),
      productName: row.productName,
      manufacturer: row.manufacturer,
      category,
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

export async function attachProjectResources(
  db: Database,
  projectId: ProjectId,
  productIds: ProductId[],
  actor: ActorContext,
): Promise<{ changed: number; attached: number }> {
  const uniqueProductIds = uniq(productIds);
  return withTransaction(db, async (tx) => {
    const liveProject = await tx.query.project.findFirst({
      where: and(eq(project.id, projectId), notDeleted(project)),
      columns: { id: true },
    });
    if (!liveProject) {
      throw createAppError(
        "PROJECT_NOT_FOUND",
        `Project ${projectId} not found`,
      );
    }

    const liveResources = await tx.query.product.findMany({
      where: and(
        inArray(product.id, uniqueProductIds),
        inArray(product.category, ["tools", "software"]),
        notDeleted(product),
      ),
      columns: { id: true },
    });
    if (liveResources.length !== uniqueProductIds.length) {
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        "Every attached Product must exist, be live, and have category tools or software.",
      );
    }

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
    return { changed: inserted.length, attached: after.length };
  });
}

export async function detachProjectResources(
  db: Database,
  projectId: ProjectId,
  productIds: ProductId[],
  actor: ActorContext,
): Promise<{ changed: number; attached: number }> {
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
    return { changed: removed.length, attached: after.length };
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
): Promise<ProjectToolSuggestionsOut> {
  const dbc = getDb(db);
  const [attachedRows, taskTrades, expenseTrades, directRows, inventoryRows] =
    await Promise.all([
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
        .select({ trade: task.trade, taskCount: count() })
        .from(task)
        .where(
          and(
            eq(task.projectId, projectId),
            ne(task.trade, "planning"),
            ne(task.trade, "other"),
            notDeleted(task),
          ),
        )
        .groupBy(task.trade),
      dbc
        .select({
          trade: expense.trade,
          expenseCount: count(),
          grossSpend: sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(
            Number,
          ),
        })
        .from(expense)
        .where(
          and(
            eq(expense.projectId, projectId),
            eq(expense.lineKind, "principal"),
            eq(expense.future, false),
            gt(expense.cost, 0),
            ne(expense.trade, "planning"),
            ne(expense.trade, "other"),
            notDeleted(expense),
          ),
        )
        .groupBy(expense.trade),
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
            eq(expense.projectId, projectId),
            eq(expense.lineKind, "principal"),
            eq(expense.future, false),
            eq(expense.costType, "tools"),
            gt(expense.cost, 0),
            eq(product.category, "tools"),
            notDeleted(expense),
          ),
        )
        .groupBy(
          product.id,
          product.shortcode,
          product.name,
          product.manufacturer,
        ),
      dbc
        .selectDistinct({ productId: inventoryEntry.productId })
        .from(inventoryEntry)
        .innerJoin(
          product,
          and(eq(product.id, inventoryEntry.productId), notDeleted(product)),
        )
        .where(and(eq(product.category, "tools"), notDeleted(inventoryEntry))),
    ]);

  const attached = new Set(attachedRows.map((row) => row.productId));
  const inventoried = new Set(inventoryRows.map((row) => row.productId));
  const taskCountByTrade = new Map(
    taskTrades.map((row) => [row.trade, Number(row.taskCount)]),
  );
  const expenseByTrade = new Map(
    expenseTrades.map((row) => [
      row.trade,
      {
        expenseCount: Number(row.expenseCount),
        grossSpend: row.grossSpend,
      },
    ]),
  );
  const trades = uniq([
    ...taskTrades.map((row) => row.trade),
    ...expenseTrades.map((row) => row.trade),
  ])
    .map(
      (trade): ProjectTradeSignal => ({
        trade,
        taskCount: taskCountByTrade.get(trade) ?? 0,
        expenseCount: expenseByTrade.get(trade)?.expenseCount ?? 0,
        grossSpend: expenseByTrade.get(trade)?.grossSpend ?? 0,
      }),
    )
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
            trade: expense.trade,
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
                expense.trade,
                trades.map((signal) => signal.trade),
              ),
              eq(expense.future, false),
              eq(expense.lineKind, "principal"),
              eq(expense.costType, "tools"),
              gt(expense.cost, 0),
              eq(product.category, "tools"),
              notDeleted(expense),
            ),
          )
          .groupBy(
            product.id,
            product.shortcode,
            product.name,
            product.manufacturer,
            expense.trade,
          );

  const candidateProductIds = uniq([
    ...directRows.map((row) => row.productId),
    ...tradeRows.map((row) => row.productId),
  ]);
  const metrics = await loadResourceMetrics(dbc, candidateProductIds);

  const directSuggestions: ProjectToolSuggestionOut[] = directRows
    .filter(
      (row) =>
        !attached.has(row.productId) &&
        row.projectPurchaseCost >= EXPENSIVE_TOOL_THRESHOLD,
    )
    .map((row) => ({
      productId: unsafeProductShortcode(row.productCode),
      productName: row.productName,
      manufacturer: row.manufacturer,
      lane: "purchased_here" as const,
      matchedTrade: null,
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
    const current = tradeRowsByTrade.get(row.trade) ?? [];
    current.push(row);
    tradeRowsByTrade.set(row.trade, current);
  }

  const chosenTradeProductIds = new Set<ProductId>();
  const tradeSuggestions: ProjectToolSuggestionOut[] = [];
  for (const signal of trades) {
    const ranked = (tradeRowsByTrade.get(signal.trade) ?? [])
      .filter((row) => {
        const toolMetrics = metrics.get(row.productId) ?? EMPTY_METRICS;
        return (
          inventoried.has(row.productId) &&
          !attached.has(row.productId) &&
          !expensiveDirectIds.has(row.productId) &&
          !chosenTradeProductIds.has(row.productId) &&
          (toolMetrics.grossLifetimeAcquisitionCost >=
            EXPENSIVE_TOOL_THRESHOLD ||
            toolMetrics.projectUseCount >= REUSED_CHEAP_TOOL_PROJECTS)
        );
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
        productId: unsafeProductShortcode(row.productCode),
        productName: row.productName,
        manufacturer: row.manufacturer,
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
        eq(expense.projectId, projectId),
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
      projectId: expense.projectId,
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
    row.cost === null ? [] : [{ ...row, cost: row.cost }],
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
      category: true,
      name: true,
      manufacturer: true,
    },
  });
  if (!productRow) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${productId} not found`);
  }
  if (productRow.category !== "tools" && productRow.category !== "software") {
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      `${productRow.name} is not a reusable tool or software Product`,
    );
  }
  const category = productRow.category;

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
      category === "tools"
        ? loadProductPurchaseCostsByProject(dbc, productId, projectIds)
        : new Map<ProjectId, number>(),
      category === "software" ? loadProjectDateWindows(db) : null,
    ]);
  const metrics = metricsByProduct.get(productId) ?? EMPTY_METRICS;
  const windowContexts = loadedWindows
    ? buildResourceWindowContexts(
        loadedWindows,
        projectIds,
        options.today ?? format(new Date(), "yyyy-MM-dd"),
      )
    : new Map<ProjectId, ResourceWindowContext | null>();
  const softwareExpenses =
    category === "software"
      ? await loadSoftwareExpenseRows(dbc, productId, windowContexts)
      : [];

  return {
    productId: unsafeProductShortcode(productRow.shortcode),
    productName: productRow.name,
    manufacturer: productRow.manufacturer,
    category,
    ...publicResourceMetrics(category, metrics),
    projects: rows.map((row) => ({
      projectId: unsafeProjectShortcode(row.projectCode),
      projectName: row.projectName,
      status: row.status,
      kind: row.kind,
      projectPurchaseCost:
        category === "tools"
          ? (purchaseCostByProject.get(row.projectId) ?? 0)
          : null,
      sharedWindow:
        category === "software"
          ? softwareSharedWindow(
              windowContexts.get(row.projectId),
              softwareExpenses,
            )
          : null,
      attachedAt: row.attachedAt,
    })),
  };
}
