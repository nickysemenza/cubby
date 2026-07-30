import type { Entity } from "@cubby/schemas/entity";
import type { Table } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { Row } from "~/components/layout";
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
        {bulkActionBar}
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

        {actions}
      </Row>
    </Row>
  );
}
