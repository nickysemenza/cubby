/**
 * The projects x tools matrix behind the `/tools` Usage view — one read that returns
 * every column, row, and non-empty cell of the grid.
 *
 * Why it exists: `projectTool` records that a tool was used on a project,
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
import type { ProjectId } from "@cubby/schemas/identifiers";
import {
  projectToolMatrixRowOut,
  projectToolMatrixColumnOut,
} from "@cubby/schemas/project";
import type {
  ProjectToolMatrixFilters,
  ProjectToolMatrixOut,
  ProjectToolSuggestionLane,
  Trade,
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

import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { actualExpense } from "~/server/db/computed/expense-aggregate-sql";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import {
  buildSearchConditions,
  formatSearchTerm,
  getDb,
  notDeleted,
} from "~/server/db/helpers";
import {
  entityLink,
  expense,
  inventoryEntry,
  product,
  project,
  task,
} from "~/server/db/schema";
import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
} from "~/server/domains/expense/repo/expense-inheritance";
import { categoryFeatureSql } from "~/server/domains/product-category/repo/category-feature";
import { loadProductOwnershipTimelines } from "~/server/domains/product/repo/ownership";
import { publicFieldEnvelopeRows } from "~/server/generic/derived/repo/public-read";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";

import { buildDashboardProjectWhere } from "./dashboard-shared";
import { loadProjectDateWindows, projectCompletionYear } from "./subtree";
import {
  projectToolMatrixRows,
  finishToolMatrix,
  selectToolMatrixPage,
} from "./tool-matrix-projection";
import { deriveToolTrades } from "./tool-trades";
import { loadProjectToolPurchaseCosts, loadResourceMetrics } from "./tools";

const effectiveExpenseProject = effectiveExpenseProjectSql();
const effectiveExpenseTrade = effectiveExpenseTradeSql();
const effectiveTaskProject = effectiveFieldSql<ProjectId | null>(
  "task",
  "projectId",
);
const effectiveTaskTrade = effectiveFieldSql<Trade | null>("task", "trade");
type ProjectDateWindows = Awaited<ReturnType<typeof loadProjectDateWindows>>;

const toolNameSearchCondition = (search: string | undefined) =>
  search
    ? or(
        formatSearchTerm(product.name, search),
        formatSearchTerm(productBrandNameSql(product.brandId), search),
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

async function loadToolMatrixPage(
  db: Database,
  filters: ProjectToolMatrixFilters,
) {
  const dbc = getDb(db);
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
        brandName: productBrandNameSql(product.brandId),
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
          actualExpense(),
          notDeleted(expense),
        ),
      )
      .where(
        buildSearchConditions(
          product,
          [],
          [
            categoryFeatureSql(sql`${product.categoryId}`, "tools"),
            toolNameSearchCondition(toolSearch),
          ],
        ),
      )
      .groupBy(
        product.id,
        product.shortcode,
        product.name,
        productBrandNameSql(product.brandId),
      )
      .having(
        sql`coalesce(sum(${expense.cost}), 0) >= ${filters.minNetLifetimeCost}`,
      )
      .orderBy(desc(sql`coalesce(sum(${expense.cost}), 0)`), asc(product.name)),
  ]);

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
        emoji: project.emoji,
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
          actualExpense(),
          gt(expense.cost, 0),
          notDeleted(expense),
        ),
      )
      .groupBy(effectiveExpenseProject),
  ]);

  return { dated, memberRows, projectRows, toolSignalRows };
}

export type ToolMatrixPageLoaded = Awaited<
  ReturnType<typeof loadToolMatrixPage>
>;

async function loadToolMatrix(
  db: Database,
  filters: ProjectToolMatrixFilters,
  options: { today?: string } = {},
) {
  const dbc = getDb(db);
  const today = options.today ?? householdLocalDate();
  const wantsLane = (lane: ProjectToolSuggestionLane): boolean =>
    filters.suggestionLanes === undefined ||
    filters.suggestionLanes.includes(lane);
  const page = await loadToolMatrixPage(db, filters);
  const { dated } = page;
  const {
    matchingTools,
    rowRecords,
    rowIds,
    matchingProjects,
    pageCount,
    resolvedPage,
    columnRecords,
    columnIds,
    completionYears,
  } = selectToolMatrixPage(filters, page);
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
              projectId: entityLink.fromEntityId,
              productId: entityLink.toEntityId,
            })
            .from(entityLink)
            .where(
              and(
                inArray(entityLink.fromEntityId, columnIds),
                inArray(entityLink.toEntityId, rowIds),
                liveLinks("projectTool"),
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
                actualExpense(),
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
                categoryFeatureSql(sql`${product.categoryId}`, "tools"),
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
                actualExpense(),
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

  return {
    dated,
    rowRecords,
    columnRecords,
    columnIds,
    today,
    matchingTools,
    matchingProjects,
    pageCount,
    resolvedPage,
    completionYears,
    tradeByProduct,
    attachedRows,
    purchasedRows,
    taskTradeRows,
    expenseTradeRows,
    inventoryRows,
    candidateRows,
    metrics,
    ownership,
  };
}

export type ToolMatrixLoaded = Awaited<ReturnType<typeof loadToolMatrix>>;

export async function projectToolMatrix(
  db: Database,
  filters: ProjectToolMatrixFilters,
  options: { today?: string } = {},
): Promise<ProjectToolMatrixOut> {
  const loaded = await loadToolMatrix(db, filters, options);
  const projection = projectToolMatrixRows(filters, loaded);
  const { columns, rows } = projection;
  const [publicColumns, publicRows] = await Promise.all([
    publicFieldEnvelopeRows({
      db,
      entity: "project",
      schema: projectToolMatrixColumnOut,
      rows: columns.map((row) => ({ ...row, id: row.projectId })),
    }),
    publicFieldEnvelopeRows({
      db,
      entity: "product",
      schema: projectToolMatrixRowOut,
      rows: rows.map((row) => ({ ...row, id: row.productId })),
    }),
  ]);
  return finishToolMatrix(
    filters,
    loaded,
    projection,
    publicColumns,
    publicRows,
  );
}
