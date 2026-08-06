import type { ProjectShortcode } from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";
import type { PurchaseFilters, PurchaseOut } from "@cubby/schemas/purchase";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import {
  createNameColumn,
  createPlainDateColumn,
  type RowLinkResolver,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";
import {
  buildProjectPurchaseRows,
  type ProjectPurchaseRow,
  projectPurchaseSubRows,
} from "./project-purchase-rows";

const EMBEDDED_TABLE_STATE = {
  initialSort: "date",
  urlSync: false,
  readUrlState: false,
  syncPaginationToUrl: false,
} as const;

/** Children are Expenses, so each row links to its own entity's detail page. */
const rowLink: RowLinkResolver<ProjectPurchaseRow> = (row) =>
  row.kind === "purchase"
    ? {
        to: entities.purchase.routes.detail,
        params: entityDetailParams(row.id),
      }
    : {
        to: entities.expense.routes.detail,
        // The row id is namespaced by its parent purchase; the expense's own
        // shortcode is what the route wants.
        params: entityDetailParams(row.expenseId),
      };

const rowIsEntity = (row: ProjectPurchaseRow) => row.kind === "purchase";

/**
 * The purchase entity's default-on Expenses preview column is exactly what the
 * twirl-down already shows, one row further in. Reachable from the View menu.
 */
const INITIAL_COLUMN_VISIBILITY = {
  "related:purchase.expenses": false,
} as const;

/**
 * The vendor charges behind this project's ledger, each twirling open to the
 * lines it charged HERE.
 *
 * Membership is the server's: `purchase.list` applies `projectId` as an EXISTS
 * over the purchase's expenses. The child lines are joined client-side from the
 * project's own already-fetched expense set rather than re-queried per row —
 * that's decorating rows the server chose, not choosing them.
 *
 * Scope is the exact project, not the subtree (matching the Vendors section):
 * `PurchaseFilters` has no `projectScope`.
 */
export function ProjectPurchasesTable({
  projectId,
  expenses,
}: {
  projectId: ProjectShortcode;
  /** The project's ledger rows — the subtree set the page already holds. */
  expenses: readonly ExpenseOut[];
}) {
  const api = useTRPC();
  const helper = useMemo(() => createColumnHelper<ProjectPurchaseRow>(), []);
  const scope = useMemo<Partial<PurchaseFilters>>(
    () => ({ projectId }),
    [projectId],
  );

  const tree = useMemo(
    () => ({
      nest: (purchases: PurchaseOut[]) =>
        buildProjectPurchaseRows(purchases, expenses, projectId),
      getSubRows: projectPurchaseSubRows,
      rowLink,
      rowIsEntity,
    }),
    [expenses, projectId],
  );

  const columns = useMemo(
    () => [
      createNameColumn(helper, "purchase", "name", {
        header: "Purchase",
        className: "w-72",
        expandable: true,
        rowLink,
        // A purchase reaches this table because at least one of its lines is
        // on this project; say when the rest of the charge went elsewhere.
        nameSuffix: (row) =>
          row.kind === "purchase" &&
          row.linesOnProject > 0 &&
          row.linesOnProject < row.purchase.expenseCount ? (
            <Badge variant="outline" className="shrink-0">
              {row.linesOnProject} of {row.purchase.expenseCount} lines
            </Badge>
          ) : null,
      }),
      createPlainDateColumn(helper, "date", { header: "Date" }),
      helper.display({
        id: "vendor",
        header: "Vendor",
        meta: { className: "w-40" },
        cell: (info) => {
          const row = info.row.original;
          if (row.kind !== "purchase") return null;
          return <span className="truncate">{row.purchase.vendorName}</span>;
        },
      }),
      helper.accessor(
        (row) =>
          row.kind === "purchase" ? row.projectSpend : row.expense.cost,
        {
          id: "projectSpend",
          header: "On this project",
          meta: { className: "w-32", numeric: true, mono: true },
          cell: (info) => {
            const value = info.getValue();
            return value == null ? <NoneValue /> : formatCurrency(value);
          },
        },
      ),
      helper.display({
        id: "charge",
        header: "Whole charge",
        meta: { className: "w-32", numeric: true, mono: true },
        cell: (info) => {
          const row = info.row.original;
          if (row.kind !== "purchase") return null;
          return (
            <Row justify="end" gap="xs">
              <span>{formatCurrency(row.purchase.expenseTotal)}</span>
            </Row>
          );
        },
      }),
    ],
    [helper],
  );

  const list = useEntityList<ProjectPurchaseRow, PurchaseFilters, PurchaseOut>({
    entity: "purchase",
    queryOptions: api.purchase.list.queryOptions,
    scopeFilters: scope,
    columns,
    tree,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    columnVisibilityScope: "project-detail",
    initialColumnVisibility: INITIAL_COLUMN_VISIBILITY,
    hiddenFilterColumns: ["project"],
  });

  return (
    <RTable
      table={list.table}
      isLoading={list.isLoading}
      error={list.error}
      timing={list.timing}
      entity="purchase"
      sizingKey="purchase:project-detail"
      ariaLabel="Purchases charged to this project"
      embedded
      showColumnMenu
      infiniteScroll={list.infiniteScroll}
      refreshControls={list.refreshControls}
      emptyState="No vendor charges have been linked to this project's expenses yet."
    />
  );
}
