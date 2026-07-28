import type { Entity } from "@cubby/schemas/entity";
import type { Table } from "@tanstack/react-table";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { ActiveFilterChips } from "./ActiveFilterChips";
import { DataTableViews } from "./DataTableViews";
import { DataTableViewOptions } from "./data-table-view-options";

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
  className,
}: DataTableToolbarProps<TData>) {
  const isFiltered = table.getState().columnFilters.length > 0;

  return (
    <Row align="center" justify="between" gap="sm" className={className}>
      <Row align="center" gap="sm">
        {showViewOptions && <DataTableViewOptions table={table} />}
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

        {/* Chips take their own line on narrow screens rather than squeezing
            the actions off the right edge. */}
        <div className="order-last w-full min-w-0 lg:order-none lg:w-auto">
          <ActiveFilterChips table={table} />
        </div>

        {isFiltered && (
          <Button
            variant="ghost"
            size="default"
            onClick={() => {
              table.resetColumnFilters();
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
