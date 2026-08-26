import type { Entity } from "@cubby/schemas/entity";
import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Row } from "~/components/layout";
import { usePageWorkbenchTarget } from "~/components/page/Page";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { DataTableViews } from "./DataTableViews";
import { DataTableViewOptions } from "./data-table-view-options";
import { LedgerFilters } from "./LedgerFilters";
import { ProblemWorklistStatus } from "./problem-worklist";
import type { CubbyTable as Table } from "./table-features";
import type { TableDensity } from "./useTableDensity";

interface DataTableToolbarProps<TData extends RowData> {
  table: Table<TData>;
  /** Which entity this table lists — drives the saved-views menu, which
   *  renders nothing for an entity with no declared views. */
  entity?: Entity;
  /** Slot for additional content like summaries (e.g., "Value: $5,845.91") */
  additionalContent?: ReactNode;
  /** Primary actions (e.g., "Create New" button) */
  actions?: ReactNode;
  /** Bulk action bar (rendered when rows selected, replaces view options) */
  bulkActionBar?: ReactNode;
  /** Show desktop view options dropdown (column toggles) */
  showViewOptions?: boolean;
  /** Additional className for styling */
  className?: string;
  /** Previous-query rows remain visible while the next first page is loading. */
  isTransitioning?: boolean;
  /** Server-side facet count hints forwarded to the mounted filter controls. */
  filterOptionHints?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  /** Hoist Display/Saved views into the stable page-workbench first tier. */
  portalWorkbenchUtilities?: boolean;
  /** CSS gate used while desktop and phone table branches coexist pre-hydration. */
  workbenchUtilityViewport?: "all" | "desktop" | "mobile";
  /** Must match the table controller's first-visit density. */
  defaultDensity?: TableDensity;
}

export function DataTableToolbar<TData extends RowData>({
  table,
  entity,
  additionalContent,
  actions,
  bulkActionBar,
  showViewOptions = true,
  className,
  isTransitioning = false,
  filterOptionHints,
  portalWorkbenchUtilities = false,
  workbenchUtilityViewport = "all",
  defaultDensity,
}: DataTableToolbarProps<TData>) {
  const workbenchTarget = usePageWorkbenchTarget();
  const utilities = (
    <>
      {showViewOptions && (
        <DataTableViewOptions table={table} defaultDensity={defaultDensity} />
      )}
      <DataTableViews table={table} entity={entity} />
    </>
  );
  const utilityClass =
    workbenchUtilityViewport === "desktop"
      ? "hidden md:flex"
      : workbenchUtilityViewport === "mobile"
        ? "flex md:hidden"
        : "flex";
  return (
    <>
      {portalWorkbenchUtilities &&
        workbenchTarget &&
        createPortal(
          <div className={`${utilityClass} items-center gap-1`}>
            {utilities}
          </div>,
          workbenchTarget,
        )}
      <div
        className={cn(
          "flex min-h-10 min-w-0 flex-wrap items-center gap-2 bg-card px-2 py-1",
          className,
        )}
      >
        <Row align="center" gap="xs" className="shrink-0">
          {entity && (
            <ProblemWorklistStatus
              entity={entity}
              filters={table.state.columnFilters}
              sorting={table.state.sorting}
            />
          )}
          {!portalWorkbenchUtilities && utilities}
          {isTransitioning && (
            <Row
              align="center"
              gap="xs"
              aria-live="polite"
              className="text-muted-foreground text-xs"
            >
              <Spinner size="sm" />
              Updating…
            </Row>
          )}
        </Row>

        <div className="min-w-0 flex-1">
          <fieldset
            disabled={isTransitioning}
            className="data-table-query-tier contents"
          >
            <div data-query-bulk className="contents">
              {bulkActionBar}
            </div>
            <Row data-query-rest align="center" justify="end" gap="sm" wrap>
              {additionalContent}
              <div className="min-w-0 flex-1">
                <LedgerFilters table={table} optionHints={filterOptionHints} />
              </div>
              {actions}
            </Row>
          </fieldset>
        </div>
      </div>
    </>
  );
}
