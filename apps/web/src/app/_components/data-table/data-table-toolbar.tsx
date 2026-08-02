import type { Entity } from "@cubby/schemas/entity";
import type { Table } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { Row } from "~/components/layout";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { DataTableViews } from "./DataTableViews";
import { DataTableViewOptions } from "./data-table-view-options";
import { LedgerFilters } from "./LedgerFilters";

interface DataTableToolbarProps<TData> {
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
  /** Clear this table's persisted column widths (see DataTableViewOptions). */
  onResetColumnWidths?: () => void;
  /** Additional className for styling */
  className?: string;
  /** Previous-query rows remain visible while the next first page is loading. */
  isTransitioning?: boolean;
}

export function DataTableToolbar<TData>({
  table,
  entity,
  additionalContent,
  actions,
  bulkActionBar,
  showViewOptions = true,
  onResetColumnWidths,
  className,
  isTransitioning = false,
}: DataTableToolbarProps<TData>) {
  return (
    <Row align="center" justify="between" gap="sm" className={className}>
      <Row align="center" gap="sm">
        {showViewOptions && (
          <DataTableViewOptions
            table={table}
            onResetColumnWidths={onResetColumnWidths}
          />
        )}
        <DataTableViews table={table} entity={entity} />
        <fieldset disabled={isTransitioning} className="contents">
          {bulkActionBar}
        </fieldset>
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

      <Row
        align="center"
        gap="sm"
        wrap
        className={cn(
          "min-w-0 flex-1",
          showViewOptions || bulkActionBar ? "justify-end" : "justify-start",
        )}
      >
        {additionalContent}

        <div className="order-last w-full min-w-0 lg:order-none lg:w-auto">
          <LedgerFilters table={table} />
        </div>

        <fieldset disabled={isTransitioning} className="contents">
          {actions}
        </fieldset>
      </Row>
    </Row>
  );
}
