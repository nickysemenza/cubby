import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId, ProjectId } from "@cubby/schemas/identifiers";
import {
  unsafeProductShortcode,
  unsafeProjectShortcode,
} from "@cubby/schemas/identifiers";
import type {
  ProductProjectUsesOut,
  ProjectToolOut,
  ProjectToolSuggestionOut,
  ProjectToolSuggestionsOut,
  Trade,
} from "@cubby/schemas/project";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
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

const EXPENSIVE_TOOL_THRESHOLD = 100;
const REUSED_CHEAP_TOOL_PROJECTS = 2;
const MAX_TRADE_SUGGESTIONS = 20;
const MAX_SUGGESTIONS_PER_TRADE = 5;

type ToolMetrics = {
  projectUseCount: number;
  netLifetimeCost: number;
  costPerProjectUse: number | null;
  grossLifetimeAcquisitionCost: number;
};

const EMPTY_METRICS: ToolMetrics = {
  projectUseCount: 0,
  netLifetimeCost: 0,
  costPerProjectUse: null,
  grossLifetimeAcquisitionCost: 0,
};

async function loadToolMetrics(
  dbc: DrizzleClient,
  productIds: ProductId[],
): Promise<Map<ProductId, ToolMetrics>> {
  const result = new Map<ProductId, ToolMetrics>();
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

export async function listProjectTools(
  db: Database,
  projectId: ProjectId,
): Promise<ProjectToolOut[]> {
  const dbc = getDb(db);
  const rows = await dbc
    .select({
      productId: projectToolUsage.productId,
      productCode: product.shortcode,
      productName: product.name,
      manufacturer: product.manufacturer,
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
  const [metrics, purchaseCosts] = await Promise.all([
    loadToolMetrics(dbc, productIds),
    loadProjectPurchaseCosts(dbc, projectId, productIds),
  ]);

  return rows.map((row) => ({
    productId: unsafeProductShortcode(row.productCode),
    productName: row.productName,
    manufacturer: row.manufacturer,
    attachedAt: row.attachedAt,
    projectPurchaseCost: purchaseCosts.get(row.productId) ?? 0,
    ...(metrics.get(row.productId) ?? EMPTY_METRICS),
  }));
}

async function liveToolCodes(
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

export async function attachProjectTools(
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

    const liveTools = await tx.query.product.findMany({
      where: and(
        inArray(product.id, uniqueProductIds),
        eq(product.category, "tools"),
        notDeleted(product),
      ),
      columns: { id: true },
    });
    if (liveTools.length !== uniqueProductIds.length) {
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        "Every attached Product must exist, be live, and have category tools.",
      );
    }

    const before = await liveToolCodes(tx, projectId);
    const inserted = await tx
      .insert(projectToolUsage)
      .values(uniqueProductIds.map((productId) => ({ projectId, productId })))
      .onConflictDoNothing()
      .returning({ id: projectToolUsage.id });
    const after = await liveToolCodes(tx, projectId);

    if (inserted.length > 0) {
      await logAuditEntry(tx, actor, {
        entityType: "project",
        entityId: projectId,
        action: "update",
        changes: { usedToolIds: { from: before, to: after } },
      });
    }
    return { changed: inserted.length, attached: after.length };
  });
}

export async function detachProjectTools(
  db: Database,
  projectId: ProjectId,
  productIds: ProductId[],
  actor: ActorContext,
): Promise<{ changed: number; attached: number }> {
  const uniqueProductIds = uniq(productIds);
  return withTransaction(db, async (tx) => {
    const before = await liveToolCodes(tx, projectId);
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
    const after = await liveToolCodes(tx, projectId);

    if (removed.length > 0) {
      await logAuditEntry(tx, actor, {
        entityType: "project",
        entityId: projectId,
        action: "update",
        changes: { usedToolIds: { from: before, to: after } },
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
  const metrics = await loadToolMetrics(dbc, candidateProductIds);

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

export async function listProductProjectUses(
  db: Database,
  productId: ProductId,
): Promise<ProductProjectUsesOut> {
  const dbc = getDb(db);
  const productRow = await dbc.query.product.findFirst({
    where: and(eq(product.id, productId), notDeleted(product)),
    columns: { shortcode: true },
  });
  if (!productRow) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${productId} not found`);
  }

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

  const metrics =
    (await loadToolMetrics(dbc, [productId])).get(productId) ?? EMPTY_METRICS;
  const purchaseCostByProject = await loadProductPurchaseCostsByProject(
    dbc,
    productId,
    rows.map((row) => row.projectId),
  );

  return {
    productId: unsafeProductShortcode(productRow.shortcode),
    ...metrics,
    projects: rows.map((row) => ({
      projectId: unsafeProjectShortcode(row.projectCode),
      projectName: row.projectName,
      status: row.status,
      kind: row.kind,
      projectPurchaseCost: purchaseCostByProject.get(row.projectId) ?? 0,
      attachedAt: row.attachedAt,
    })),
  };
}
