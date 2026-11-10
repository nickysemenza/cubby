import type { ProductId, ProjectId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  ProjectToolMatrixCellOut,
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
import type { rawToolProductIdentity } from "@cubby/schemas/project-tool-raw-read";
import { uniq } from "es-toolkit";
import type { z } from "zod";

import { toolTimelineConflict, UNKNOWN_OWNERSHIP } from "~/lib/tool-timeline";

import { projectCompletionYear } from "./subtree";
import type { ToolMatrixPageLoaded } from "./tool-matrix";
import type { ToolMatrixLoaded } from "./tool-matrix";
import {
  buildTimelineGates,
  EMPTY_METRICS,
  EXPENSIVE_TOOL_THRESHOLD,
  MAX_SUGGESTIONS_PER_TRADE,
  MAX_TRADE_SUGGESTIONS,
  REUSED_CHEAP_TOOL_PROJECTS,
  type ResourceMetrics,
} from "./tools";

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
function groupSortKey(groupBy: "trade" | "brandName", key: string): number {
  if (key === "") return Number.MAX_SAFE_INTEGER; // unassigned always last
  if (groupBy === "brandName") return 0;
  const parsedTrade = tradeSchema.safeParse(key);
  if (!parsedTrade.success) return Number.MAX_SAFE_INTEGER - 1;
  const index = tradeValues.indexOf(parsedTrade.data);
  return index === -1 ? Number.MAX_SAFE_INTEGER - 1 : index;
}

function groupLabel(groupBy: "trade" | "brandName", key: string): string {
  if (key === "") {
    return groupBy === "trade"
      ? UNASSIGNED_TRADE_LABEL
      : UNKNOWN_MANUFACTURER_LABEL;
  }
  if (groupBy === "brandName") return key;
  const parsedTrade = tradeSchema.safeParse(key);
  return parsedTrade.success ? TRADE_LABELS[parsedTrade.data] : key;
}

/**
 * Row cap. Applied AFTER counting, so `totals.matchingTools` stays truthful and
 * `truncated.rows` means what it says. Generous because the whole tool catalogue
 * is ~425 products — the cap is a backstop against a pathological filter, not a
 * paging mechanism.
 */
const MAX_MATRIX_ROWS = 250;
export function selectToolMatrixPage(
  filters: ProjectToolMatrixFilters,
  page: ToolMatrixPageLoaded,
) {
  const { dated, memberRows, projectRows, toolSignalRows } = page;
  const matchingTools = memberRows.length;
  const rowRecords = memberRows.slice(0, MAX_MATRIX_ROWS);
  const rowIds = rowRecords.map((row) => row.productId);
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

  return {
    matchingTools,
    rowRecords,
    rowIds,
    matchingProjects,
    pageCount,
    resolvedPage,
    columnRecords,
    columnIds,
    completionYears,
  };
}

export function projectToolMatrixRows(
  filters: ProjectToolMatrixFilters,
  loaded: ToolMatrixLoaded,
) {
  const {
    dated,
    rowRecords,
    columnRecords,
    columnIds,
    today,
    tradeByProduct,
    attachedRows,
    purchasedRows,
    taskTradeRows,
    expenseTradeRows,
    inventoryRows,
    candidateRows,
    metrics,
    ownership,
  } = loaded;
  const wantsLane = (lane: ProjectToolSuggestionLane) =>
    filters.suggestionLanes === undefined ||
    filters.suggestionLanes.includes(lane);
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
    attachedRows.map((row) =>
      cellKey(
        parseEntityId("project", row.projectId),
        parseEntityId("product", row.productId),
      ),
    ),
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
  const rows: Array<
    Omit<ProjectToolMatrixRowOut, "fields"> &
      z.output<typeof rawToolProductIdentity>
  > = rowRecords.map((record) => {
    const trade = tradeByProduct.get(record.productId) ?? null;
    const groupKey =
      filters.groupBy === "trade"
        ? (trade ?? "")
        : (record.brandName?.trim() ?? "");
    return {
      productId: parseShortcodeFor("product", record.shortcode),
      productName: record.name,
      brandName: record.brandName,
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

  const columns = columnRecords.map((record) => ({
    projectId: parseShortcodeFor("project", record.shortcode),
    projectName: record.name,
    emoji: record.emoji,
    status: record.status,
    kind: record.kind,
    startDate: record.startDate,
    endDate: record.endDate,
    startSource: record.startSource,
    endSource: record.endSource,
    attachedCount: attachedByProject.get(record.id) ?? 0,
    suggestedCount: suggestedByProject.get(record.id) ?? 0,
  }));

  return { rows, columns, groups, cells, timelineConflictCells };
}

type Projection = ReturnType<typeof projectToolMatrixRows>;
export function finishToolMatrix(
  filters: ProjectToolMatrixFilters,
  loaded: ToolMatrixLoaded,
  projection: Projection,
  publicColumns: ProjectToolMatrixOut["columns"],
  publicRows: ProjectToolMatrixOut["rows"],
): ProjectToolMatrixOut {
  const {
    matchingProjects,
    matchingTools,
    pageCount,
    resolvedPage,
    completionYears,
    rowRecords,
  } = loaded;
  const { groups, cells, timelineConflictCells } = projection;
  return {
    groupBy: filters.groupBy,
    groups,
    columns: publicColumns,
    rows: publicRows,
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
