/**
 * The projects x tools matrix behind `/projects/tools` — one read that returns
 * every column, row, and non-empty cell of the grid.
 *
 * Why it exists: `ProjectToolUsage` records that a tool was used on a project,
 * and cost-per-use only becomes meaningful once a tool has several of those
 * edges. Attaching one project at a time through a dialog is the bottleneck, so
 * this surface exists for backfill throughput — a grid you can scan for holes.
 *
 * Two things it must NOT do, both of which would make it lie:
 *
 *   - Restate the economics. `loadResourceMetrics` and the suggestion
 *     thresholds are imported from `./tools`, so a tool's numbers here are
 *     byte-identical to the ones on its project-detail card.
 *   - Rank suggestions differently. Both lanes replay `suggestProjectTools`'s
 *     logic per column over pre-fetched rows. `project-tools.integration.test`
 *     asserts a single column reproduces that function exactly (intersected
 *     with this grid's row set) — that test is what keeps the two honest.
 *
 * Cost: 12 statements in 3 waves, constant in row and column count (13/4 when
 * `completionYear` is set, which needs the tree folded before the column WHERE
 * can be built). The naive shape — calling `suggestProjectTools` once per
 * column — is 9 statements PER COLUMN. It is avoidable because the only two
 * queries in that function which touch real volume, the inventoried set and the
 * trade-candidate pool, carry no `projectId` at all; every project-scoped one
 * is a `groupBy` away from being N-columns-wide.
 */
import type { ProductId, ProjectId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  ProjectToolMatrixCellOut,
  ProjectToolMatrixColumnOut,
  ProjectToolMatrixFilters,
  ProjectToolMatrixGroupOut,
  ProjectToolMatrixOut,
  ProjectToolMatrixRowOut,
  ProjectToolSuggestionLane,
  Trade,
} from "@cubby/schemas/project";
import {
  TRADE_LABELS,
  tradeSchema,
  tradeValues,
  UNASSIGNED_TRADE_LABEL,
  UNKNOWN_MANUFACTURER_LABEL,
} from "@cubby/schemas/project";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";

import { householdLocalDate } from "~/lib/household-date";
import { toolTimelineConflict, UNKNOWN_OWNERSHIP } from "~/lib/tool-timeline";
import type { Database } from "~/server/db";
import {
  expense,
  inventoryEntry,
  product,
  project,
  projectToolUsage,
  task,
} from "~/server/db/schema";
import {
  buildSearchConditions,
  formatSearchTerm,
  getDb,
  notDeleted,
} from "~/server/repo/database-helpers";
import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
} from "~/server/repo/expense-inheritance";
import { loadProductOwnershipTimelines } from "~/server/repo/product/ownership";
import {
  effectiveTaskProjectSql,
  effectiveTaskTradeSql,
} from "~/server/repo/task-project-inheritance";

import { buildDashboardProjectWhere } from "./dashboard-shared";
import { loadProjectDateWindows, projectCompletionYear } from "./subtree";
import { deriveToolTrades } from "./tool-trades";
import {
  buildTimelineGates,
  EMPTY_METRICS,
  EXPENSIVE_TOOL_THRESHOLD,
  loadProjectToolPurchaseCosts,
  loadResourceMetrics,
  MAX_SUGGESTIONS_PER_TRADE,
  MAX_TRADE_SUGGESTIONS,
  REUSED_CHEAP_TOOL_PROJECTS,
  type ResourceMetrics,
} from "./tools";

/**
 * Row cap. Applied AFTER counting, so `totals.matchingTools` stays truthful and
 * `truncated.rows` means what it says. Generous because the whole tool catalogue
 * is ~425 products — the cap is a backstop against a pathological filter, not a
 * paging mechanism.
 */
const MAX_MATRIX_ROWS = 250;
const effectiveExpenseProject = effectiveExpenseProjectSql();
const effectiveExpenseTrade = effectiveExpenseTradeSql();
const effectiveTaskProject = effectiveTaskProjectSql();
const effectiveTaskTrade = effectiveTaskTradeSql();
type ProjectDateWindows = Awaited<ReturnType<typeof loadProjectDateWindows>>;

type MatrixCellKey = `${ProjectId}:${ProductId}`;
const cellKey = (projectId: ProjectId, productId: ProductId): MatrixCellKey =>
  `${projectId}:${productId}`;

type TradeSignal = {
  trade: Trade;
  taskCount: number;
  expenseCount: number;
  grossSpend: number;
};

/** Group ordering: declaration order for trades, alphabetical for makers. */
function groupSortKey(groupBy: "trade" | "manufacturer", key: string): number {
  if (key === "") return Number.MAX_SAFE_INTEGER; // unassigned always last
  if (groupBy === "manufacturer") return 0;
  const parsedTrade = tradeSchema.safeParse(key);
  if (!parsedTrade.success) return Number.MAX_SAFE_INTEGER - 1;
  const index = tradeValues.indexOf(parsedTrade.data);
  return index === -1 ? Number.MAX_SAFE_INTEGER - 1 : index;
}

function groupLabel(groupBy: "trade" | "manufacturer", key: string): string {
  if (key === "") {
    return groupBy === "trade"
      ? UNASSIGNED_TRADE_LABEL
      : UNKNOWN_MANUFACTURER_LABEL;
  }
  if (groupBy === "manufacturer") return key;
  const parsedTrade = tradeSchema.safeParse(key);
  return parsedTrade.success ? TRADE_LABELS[parsedTrade.data] : key;
}

const toolNameSearchCondition = (search: string | undefined) =>
  search
    ? or(
        formatSearchTerm(product.name, search),
        formatSearchTerm(product.manufacturer, search),
      )
    : undefined;

const completionProjectIds = (
  filters: ProjectToolMatrixFilters,
  dated: ProjectDateWindows,
): ProjectId[] | undefined => {
  if (!filters.completionYear) return undefined;
  return dated.tree.allRows
    .filter((row) => {
      const window = dated.dateWindows.get(row.id);
      return (
        window && projectCompletionYear(row, window) === filters.completionYear
      );
    })
    .map((row) => row.id);
};

export async function projectToolMatrix(
  db: Database,
  filters: ProjectToolMatrixFilters,
  /** Plain-date override for deterministic live-project window tests. */
  options: { today?: string } = {},
): Promise<ProjectToolMatrixOut> {
  const dbc = getDb(db);
  const today = options.today ?? householdLocalDate();
  const wantsLane = (lane: ProjectToolSuggestionLane): boolean =>
    filters.suggestionLanes === undefined ||
    filters.suggestionLanes.includes(lane);

  // Row membership, the derived trade, and the whole-tree date fold that
  // supplies the chronological column sort.
  const toolSearch = filters.toolSearch?.trim() || undefined;
  const [dated, memberRows] = await Promise.all([
    loadProjectDateWindows(db),
    dbc
      .select({
        productId: product.id,
        shortcode: product.shortcode,
        name: product.name,
        manufacturer: product.manufacturer,
        netLifetimeCost: sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(
          Number,
        ),
      })
      .from(product)
      // LEFT join, and every expense predicate lives in the ON clause. Moving
      // any of them (notDeleted included) to the WHERE degenerates this to an
      // inner join and silently drops every tool with no qualifying expense —
      // exactly the unassigned population, and only observable at floor 0.
      // The `cubby/require-soft-delete-filter` oxlint rule scans only
      // exists()/notExists() bodies, so CI cannot catch that regression; the
      // integration test does.
      .leftJoin(
        expense,
        and(
          eq(expense.productId, product.id),
          eq(expense.lineKind, "principal"),
          eq(expense.future, false),
          notDeleted(expense),
        ),
      )
      .where(
        buildSearchConditions(
          product,
          [],
          [eq(product.category, "tools"), toolNameSearchCondition(toolSearch)],
        ),
      )
      .groupBy(
        product.id,
        product.shortcode,
        product.name,
        product.manufacturer,
      )
      .having(
        sql`coalesce(sum(${expense.cost}), 0) >= ${filters.minNetLifetimeCost}`,
      )
      .orderBy(desc(sql`coalesce(sum(${expense.cost}), 0)`), asc(product.name)),
  ]);

  const matchingTools = memberRows.length;
  const rowRecords = memberRows.slice(0, MAX_MATRIX_ROWS);
  const rowIds = rowRecords.map((row) => row.productId);

  // Columns. `buildDashboardProjectWhere` is reused verbatim: the matrix's
  // column scope IS the Projects-page scope, so a bespoke filter here would be
  // a fourth copy of rules that already drifted once.
  const completionIds = completionProjectIds(filters, dated);

  const [projectRows, toolSignalRows] = await Promise.all([
    dbc
      .select({
        id: project.id,
        shortcode: project.shortcode,
        name: project.name,
        icon: project.icon,
        status: project.status,
        kind: project.kind,
      })
      .from(project)
      .where(buildDashboardProjectWhere(filters, completionIds)),
    // "Has this project anything to do with tools at all" — an existing usage
    // edge, or tool-costType spend. Unbounded by design (82 edges household-
    // wide today) and independent of the row set, so it rides along here.
    dbc
      .select({ projectId: effectiveExpenseProject })
      .from(expense)
      .where(
        and(
          eq(expense.costType, "tools"),
          eq(expense.lineKind, "principal"),
          eq(expense.future, false),
          gt(expense.cost, 0),
          notDeleted(expense),
        ),
      )
      .groupBy(effectiveExpenseProject),
  ]);

  // The sort key is the RECURSIVE effective window, which only exists as a TS
  // fold — re-deriving it in SQL would be another copy of the same rule.
  const datedProjects = projectRows.map((row) => {
    const window = dated.dateWindows.get(row.id);
    return {
      ...row,
      startDate: window?.effectiveStart ?? null,
      endDate: window?.effectiveEnd ?? null,
      startSource: window?.startSource ?? ("none" as const),
      endSource: window?.endSource ?? ("none" as const),
    };
  });
  const chronological = (
    a: (typeof datedProjects)[number],
    b: (typeof datedProjects)[number],
  ) =>
    (a.startDate ?? "9999").localeCompare(b.startDate ?? "9999") ||
    (a.endDate ?? "9999").localeCompare(b.endDate ?? "9999") ||
    a.name.localeCompare(b.name);

  // Which projects appear first in the paged column browser, then each page is
  // displayed oldest-first. Three passes of the original cap got this wrong,
  // so the reasoning is worth keeping:
  //
  //   - NOT chronological-then-cap. That spends the grid on the oldest
  //     projects; on production it gave 24 columns of "spice rack" and "shoe
  //     rack" while every tool-heavy renovation fell off the right edge.
  //   - NOT recency alone. `effectiveEnd` honours the manual override, and the
  //     single most tool-heavy project in the database (39 of 82 edges) carries
  //     an explicit 2024-11 end date — correct domain behaviour that still
  //     ranked it below two dozen wedding and subscription projects.
  //   - So: projects that have anything to do with tools first, recency second.
  //     This is a ranking, not a hidden filter — nothing is excluded that the
  //     first page wouldn't have deferred anyway, and
  //     `totals.matchingProjects` still reports the full match count.
  //
  // Undated projects sort last within their tier, so they drop before real ones.
  const toolSignal = new Set(
    toolSignalRows.flatMap((row) => (row.projectId ? [row.projectId] : [])),
  );
  const matchingProjects = datedProjects.length;
  const priorityProjects = [...datedProjects].sort(
    (a, b) =>
      Number(toolSignal.has(b.id)) - Number(toolSignal.has(a.id)) ||
      (b.endDate ?? "0000").localeCompare(a.endDate ?? "0000") ||
      (b.startDate ?? "0000").localeCompare(a.startDate ?? "0000") ||
      a.name.localeCompare(b.name),
  );
  const pageCount = Math.ceil(matchingProjects / filters.maxColumns);
  const resolvedPage =
    pageCount === 0 ? 1 : Math.min(filters.columnPage, pageCount);
  const pageStart = (resolvedPage - 1) * filters.maxColumns;
  const columnRecords = priorityProjects
    .slice(pageStart, pageStart + filters.maxColumns)
    .sort(chronological);
  const columnIds = columnRecords.map((row) => row.id);

  const completionYears = uniq(
    dated.tree.allRows.flatMap((row) => {
      const window = dated.dateWindows.get(row.id);
      return window ? [projectCompletionYear(row, window)] : [];
    }),
  )
    .sort()
    .reverse();

  const empty = rowIds.length === 0 || columnIds.length === 0;

  // Every cell projection is batched across the visible matrix. Purchase cost
  // uses the shared suggestion predicate; installed inventory still counts as
  // owned; trade candidates stay bounded by the row cap rather than another
  // signal-dependent query wave.
  const loadMatrixInputs = () =>
    Promise.all([
      deriveToolTrades(dbc, rowIds),
      empty
        ? []
        : dbc
            .select({
              projectId: projectToolUsage.projectId,
              productId: projectToolUsage.productId,
            })
            .from(projectToolUsage)
            .where(
              and(
                inArray(projectToolUsage.projectId, columnIds),
                inArray(projectToolUsage.productId, rowIds),
                notDeleted(projectToolUsage),
              ),
            ),
      empty ? new Map() : loadProjectToolPurchaseCosts(dbc, columnIds, rowIds),
      empty || !wantsLane("trade_match")
        ? []
        : dbc
            .select({
              projectId: effectiveTaskProject,
              trade: effectiveTaskTrade,
              taskCount: count(),
            })
            .from(task)
            .where(
              and(
                inArray(effectiveTaskProject, columnIds),
                ne(effectiveTaskTrade, "planning"),
                ne(effectiveTaskTrade, "other"),
                notDeleted(task),
              ),
            )
            .groupBy(effectiveTaskProject, effectiveTaskTrade),
      empty || !wantsLane("trade_match")
        ? []
        : dbc
            .select({
              projectId: effectiveExpenseProject,
              trade: effectiveExpenseTrade,
              expenseCount: count(),
              grossSpend:
                sql<number>`coalesce(sum(${expense.cost}), 0)`.mapWith(Number),
            })
            .from(expense)
            .where(
              and(
                inArray(effectiveExpenseProject, columnIds),
                eq(expense.lineKind, "principal"),
                eq(expense.future, false),
                gt(expense.cost, 0),
                ne(effectiveExpenseTrade, "planning"),
                ne(effectiveExpenseTrade, "other"),
                notDeleted(expense),
              ),
            )
            .groupBy(effectiveExpenseProject, effectiveExpenseTrade),
      rowIds.length === 0
        ? []
        : dbc
            .selectDistinct({ productId: inventoryEntry.productId })
            .from(inventoryEntry)
            .innerJoin(
              product,
              and(
                eq(product.id, inventoryEntry.productId),
                notDeleted(product),
              ),
            )
            .where(
              and(
                inArray(inventoryEntry.productId, rowIds),
                eq(product.category, "tools"),
                notDeleted(inventoryEntry),
              ),
            ),
      empty || !wantsLane("trade_match")
        ? []
        : dbc
            .select({
              productId: expense.productId,
              trade: effectiveExpenseTrade,
              matchingExpenseCount: count(),
            })
            .from(expense)
            .where(
              and(
                inArray(expense.productId, rowIds),
                eq(expense.lineKind, "principal"),
                eq(expense.future, false),
                eq(expense.costType, "tools"),
                gt(expense.cost, 0),
                notDeleted(expense),
              ),
            )
            .groupBy(expense.productId, effectiveExpenseTrade),
      loadResourceMetrics(dbc, rowIds),
      loadProductOwnershipTimelines(dbc, rowIds, { today }),
    ]);

  const [
    tradeByProduct,
    attachedRows,
    purchasedRows,
    taskTradeRows,
    expenseTradeRows,
    inventoryRows,
    candidateRows,
    metrics,
    ownership,
  ] = await loadMatrixInputs();

  // The ownership gate. `buildTimelineGates` folds the same windows
  // `suggestProjectTools` reads, and `toolTimelineConflict` is the same pure
  // predicate the write guard and the React cell run — nothing is restated.
  const timelineGates = buildTimelineGates(dated, columnIds);
  const conflictFor = (projectId: ProjectId, productId: ProductId) => {
    const gate = timelineGates.get(projectId);
    if (!gate) return null;
    return toolTimelineConflict(
      ownership.get(productId) ?? UNKNOWN_OWNERSHIP,
      gate.window,
      { isLive: gate.isLive, today },
    );
  };
  const inventoried = new Set(
    inventoryRows.flatMap((row) => (row.productId ? [row.productId] : [])),
  );
  const attachedKeys = new Set(
    attachedRows.map((row) => cellKey(row.projectId, row.productId)),
  );
  const purchaseCostByKey = new Map<MatrixCellKey, number>();
  for (const [projectId, byProduct] of purchasedRows) {
    for (const [productId, cost] of byProduct) {
      purchaseCostByKey.set(cellKey(projectId, productId), cost);
    }
  }

  const nameByProduct = new Map(
    rowRecords.map((row) => [row.productId, row.name]),
  );
  const metricsFor = (productId: ProductId): ResourceMetrics =>
    metrics.get(productId) ?? EMPTY_METRICS;

  const candidatesByTrade = new Map<
    Trade,
    Array<{ productId: ProductId; matchingExpenseCount: number }>
  >();
  for (const row of candidateRows) {
    if (!row.productId || !row.trade) continue;
    const bucket = candidatesByTrade.get(row.trade) ?? [];
    bucket.push({
      productId: row.productId,
      matchingExpenseCount: Number(row.matchingExpenseCount),
    });
    candidatesByTrade.set(row.trade, bucket);
  }

  const signalsByProject = new Map<ProjectId, Map<Trade, TradeSignal>>();
  const signalFor = (projectId: ProjectId, trade: Trade): TradeSignal => {
    const perProject = signalsByProject.get(projectId) ?? new Map();
    signalsByProject.set(projectId, perProject);
    const existing = perProject.get(trade) ?? {
      trade,
      taskCount: 0,
      expenseCount: 0,
      grossSpend: 0,
    };
    perProject.set(trade, existing);
    return existing;
  };
  for (const row of taskTradeRows) {
    if (!row.projectId || !row.trade) continue;
    signalFor(row.projectId, row.trade).taskCount = Number(row.taskCount);
  }
  for (const row of expenseTradeRows) {
    if (!row.projectId || !row.trade) continue;
    const signal = signalFor(row.projectId, row.trade);
    signal.expenseCount = Number(row.expenseCount);
    signal.grossSpend = row.grossSpend;
  }

  const cells: ProjectToolMatrixCellOut[] = [];
  let timelineConflictCells = 0;
  const attachedByProject = new Map<ProjectId, number>();
  const suggestedByProject = new Map<ProjectId, number>();
  const visibleUseByProduct = new Map<ProductId, number>();
  const bump = <K>(map: Map<K, number>, key: K) =>
    map.set(key, (map.get(key) ?? 0) + 1);

  type MatrixColumn = (typeof columnRecords)[number];
  const appendAttachedCells = (
    column: MatrixColumn,
    projectCode: ProjectToolMatrixCellOut["projectId"],
  ) => {
    const attachedHere = new Set<ProductId>();
    for (const row of rowRecords) {
      const key = cellKey(column.id, row.productId);
      if (!attachedKeys.has(key)) continue;
      attachedHere.add(row.productId);
      cells.push({
        projectId: projectCode,
        productId: parseShortcodeFor("product", row.shortcode),
        state: "attached",
        lane: null,
        matchedTrade: null,
        projectPurchaseCost: purchaseCostByKey.get(key) ?? 0,
      });
      bump(attachedByProject, column.id);
      bump(visibleUseByProduct, row.productId);
    }
    return attachedHere;
  };

  const appendDirectSuggestions = (
    column: MatrixColumn,
    projectCode: ProjectToolMatrixCellOut["projectId"],
    attachedHere: Set<ProductId>,
  ) => {
    const expensiveDirectIds = new Set<ProductId>();
    if (!wantsLane("purchased_here")) return expensiveDirectIds;
    const direct = rowRecords.flatMap((row): ProjectToolMatrixCellOut[] => {
      const cost = purchaseCostByKey.get(cellKey(column.id, row.productId));
      if (cost === undefined || cost < EXPENSIVE_TOOL_THRESHOLD) return [];
      expensiveDirectIds.add(row.productId);
      return attachedHere.has(row.productId)
        ? []
        : [
            {
              projectId: projectCode,
              productId: parseShortcodeFor("product", row.shortcode),
              state: "suggested",
              lane: "purchased_here",
              matchedTrade: null,
              projectPurchaseCost: cost,
            },
          ];
    });
    direct.sort(
      (a, b) =>
        b.projectPurchaseCost - a.projectPurchaseCost ||
        a.productId.localeCompare(b.productId),
    );
    cells.push(...direct);
    for (const _ of direct) bump(suggestedByProject, column.id);
    return expensiveDirectIds;
  };

  const appendPurchaseEvidence = (
    column: MatrixColumn,
    projectCode: ProjectToolMatrixCellOut["projectId"],
  ) => {
    for (const row of rowRecords) {
      const key = cellKey(column.id, row.productId);
      if (attachedKeys.has(key)) continue;
      const cost = purchaseCostByKey.get(key) ?? 0;
      if (cost > 0) {
        if (cost < EXPENSIVE_TOOL_THRESHOLD || !wantsLane("purchased_here")) {
          cells.push({
            projectId: projectCode,
            productId: parseShortcodeFor("product", row.shortcode),
            state: "purchase_evidence",
            lane: null,
            matchedTrade: null,
            projectPurchaseCost: cost,
          });
        }
      } else if (conflictFor(column.id, row.productId) !== null) {
        timelineConflictCells += 1;
      }
    }
  };

  const rankedTradeCandidates = (
    column: MatrixColumn,
    signal: TradeSignal,
    attachedHere: Set<ProductId>,
    expensiveDirectIds: Set<ProductId>,
    chosen: Set<ProductId>,
  ) =>
    (candidatesByTrade.get(signal.trade) ?? [])
      .filter((candidate) => {
        const toolMetrics = metricsFor(candidate.productId);
        const economicallyRelevant =
          toolMetrics.grossLifetimeAcquisitionCost >=
            EXPENSIVE_TOOL_THRESHOLD ||
          toolMetrics.projectUseCount >= REUSED_CHEAP_TOOL_PROJECTS;
        return (
          inventoried.has(candidate.productId) &&
          !attachedHere.has(candidate.productId) &&
          !expensiveDirectIds.has(candidate.productId) &&
          !chosen.has(candidate.productId) &&
          economicallyRelevant &&
          conflictFor(column.id, candidate.productId) === null
        );
      })
      .sort((a, b) => {
        const aMetrics = metricsFor(a.productId);
        const bMetrics = metricsFor(b.productId);
        return (
          bMetrics.projectUseCount - aMetrics.projectUseCount ||
          b.matchingExpenseCount - a.matchingExpenseCount ||
          bMetrics.grossLifetimeAcquisitionCost -
            aMetrics.grossLifetimeAcquisitionCost ||
          (nameByProduct.get(a.productId) ?? "").localeCompare(
            nameByProduct.get(b.productId) ?? "",
          )
        );
      })
      .slice(0, MAX_SUGGESTIONS_PER_TRADE);

  const appendTradeSuggestions = (
    column: MatrixColumn,
    projectCode: ProjectToolMatrixCellOut["projectId"],
    attachedHere: Set<ProductId>,
    expensiveDirectIds: Set<ProductId>,
  ) => {
    if (!wantsLane("trade_match")) return;
    const signals = [...(signalsByProject.get(column.id)?.values() ?? [])].sort(
      (a, b) =>
        b.taskCount - a.taskCount ||
        b.expenseCount - a.expenseCount ||
        b.grossSpend - a.grossSpend ||
        a.trade.localeCompare(b.trade),
    );
    const chosen = new Set<ProductId>();
    let tradeCount = 0;
    for (const signal of signals) {
      if (tradeCount >= MAX_TRADE_SUGGESTIONS) break;
      const ranked = rankedTradeCandidates(
        column,
        signal,
        attachedHere,
        expensiveDirectIds,
        chosen,
      );
      for (const candidate of ranked) {
        if (tradeCount >= MAX_TRADE_SUGGESTIONS) break;
        const record = rowRecords.find(
          (row) => row.productId === candidate.productId,
        );
        if (!record) continue;
        chosen.add(candidate.productId);
        tradeCount += 1;
        cells.push({
          projectId: projectCode,
          productId: parseShortcodeFor("product", record.shortcode),
          state: "suggested",
          lane: "trade_match",
          matchedTrade: signal.trade,
          projectPurchaseCost: 0,
        });
        bump(suggestedByProject, column.id);
      }
    }
  };

  for (const column of columnRecords) {
    const projectCode = parseShortcodeFor("project", column.shortcode);
    const attachedHere = appendAttachedCells(column, projectCode);
    const expensiveDirectIds = appendDirectSuggestions(
      column,
      projectCode,
      attachedHere,
    );
    appendPurchaseEvidence(column, projectCode);
    appendTradeSuggestions(
      column,
      projectCode,
      attachedHere,
      expensiveDirectIds,
    );
  }

  // Rows, grouped and ordered. Group membership is decided here, not in React.
  const rows: ProjectToolMatrixRowOut[] = rowRecords.map((record) => {
    const trade = tradeByProduct.get(record.productId) ?? null;
    const groupKey =
      filters.groupBy === "trade" ? (trade ?? "") : record.manufacturer.trim();
    return {
      productId: parseShortcodeFor("product", record.shortcode),
      productName: record.name,
      manufacturer: record.manufacturer,
      groupKey,
      trade,
      isInventoried: inventoried.has(record.productId),
      visibleUseCount: visibleUseByProduct.get(record.productId) ?? 0,
      ownership: ownership.get(record.productId) ?? UNKNOWN_OWNERSHIP,
      ...metricsFor(record.productId),
    };
  });

  const groupKeys = uniq(rows.map((row) => row.groupKey)).sort(
    (a, b) =>
      groupSortKey(filters.groupBy, a) - groupSortKey(filters.groupBy, b) ||
      a.localeCompare(b),
  );
  const groupRank = new Map(groupKeys.map((key, index) => [key, index]));
  rows.sort(
    (a, b) =>
      (groupRank.get(a.groupKey) ?? 0) - (groupRank.get(b.groupKey) ?? 0) ||
      b.netLifetimeCost - a.netLifetimeCost ||
      a.productName.localeCompare(b.productName),
  );

  const groups: ProjectToolMatrixGroupOut[] = groupKeys.map((key) => ({
    key,
    label: groupLabel(filters.groupBy, key),
    rowCount: rows.filter((row) => row.groupKey === key).length,
  }));

  const columns: ProjectToolMatrixColumnOut[] = columnRecords.map((record) => ({
    projectId: parseShortcodeFor("project", record.shortcode),
    projectName: record.name,
    icon: record.icon,
    status: record.status,
    kind: record.kind,
    startDate: record.startDate,
    endDate: record.endDate,
    startSource: record.startSource,
    endSource: record.endSource,
    attachedCount: attachedByProject.get(record.id) ?? 0,
    suggestedCount: suggestedByProject.get(record.id) ?? 0,
  }));

  return {
    groupBy: filters.groupBy,
    groups,
    columns,
    rows,
    cells,
    columnPagination: {
      page: resolvedPage,
      pageSize: filters.maxColumns,
      pageCount,
    },
    filterOptions: { completionYears },
    totals: {
      matchingProjects,
      matchingTools,
      attachedCells: cells.filter((cell) => cell.state === "attached").length,
      suggestedCells: cells.filter((cell) => cell.state === "suggested").length,
      timelineConflictCells,
    },
    truncated: {
      rows: matchingTools > rowRecords.length,
    },
  };
}
