import type { Table } from "@tanstack/react-table";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { ActiveFilterChips } from "./ActiveFilterChips";
import { DataTableViewOptions } from "./data-table-view-options";

interface DataTableToolbarProps<TData> {
  table: Table<TData>;
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
}

export function DataTableToolbar<TData>({
  table,
  additionalContent,
  actions,
  bulkActionBar,
  showViewOptions = true,
  className,
}: DataTableToolbarProps<TData>) {
  const isFiltered =
    table.getState().columnFilters.length > 0 || table.getState().globalFilter;

  return (
    <Row align="center" justify="between" gap="sm" className={className}>
      <Row align="center" gap="sm">
        {showViewOptions && <DataTableViewOptions table={table} />}
        {bulkActionBar}
      </Row>

      <Row
        align="center"
        gap="sm"
        className={cn(
          "flex-1",
          showViewOptions || bulkActionBar ? "justify-end" : "justify-start",
        )}
      >
        {additionalContent}

        <ActiveFilterChips table={table} />

        {isFiltered && (
          <Button
            variant="ghost"
            size="default"
            onClick={() => {
              table.resetColumnFilters();
              table.setGlobalFilter({});
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
            Reset
          </Button>
        )}

        {actions}
      </Row>
    </Row>
  );
}
