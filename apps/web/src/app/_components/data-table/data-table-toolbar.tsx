import type { Table } from "@tanstack/react-table";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { DataTableViewOptions } from "./data-table-view-options";

interface DataTableToolbarProps<TData> {
  table: Table<TData>;
  /** Slot for additional content like summaries (e.g., "Value: $5,845.91") */
  additionalContent?: ReactNode;
  /** Primary actions (e.g., "Create New" button) */
  actions?: ReactNode;
  /** Bulk action bar (rendered when rows selected, replaces view options) */
  bulkActionBar?: ReactNode;
  /** Additional className for styling */
  className?: string;
}

export function DataTableToolbar<TData>({
  table,
  additionalContent,
  actions,
  bulkActionBar,
  className,
}: DataTableToolbarProps<TData>) {
  const isFiltered =
    table.getState().columnFilters.length > 0 || table.getState().globalFilter;

  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
      {/* Show bulk action bar when present, otherwise show view options */}
      {bulkActionBar ?? <DataTableViewOptions table={table} />}

      <div className="flex flex-1 items-center justify-end gap-2">
        {additionalContent}

        {/* Hide reset when bulk action bar is active to reduce clutter */}
        {isFiltered && !bulkActionBar && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              table.resetColumnFilters();
              table.setGlobalFilter({});
            }}
            className="h-7 gap-1 px-2 text-muted-foreground text-xs hover:text-foreground"
          >
            <X className="h-3 w-3" />
            Reset
          </Button>
        )}

        {actions}
      </div>
    </div>
  );
}
