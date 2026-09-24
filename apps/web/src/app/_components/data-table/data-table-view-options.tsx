import { GearSixIcon as Settings2 } from "@phosphor-icons/react/dist/csr/GearSix";
import type { RowData } from "@tanstack/react-table";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { ResponsiveSheet } from "~/components/ui/responsive-sheet";
import { humanize } from "~/entities/filters";
import { useIsMobile } from "~/hooks/useMobile";

import { isTableLayoutCustomized } from "./column-layout";
import type {
  CubbyColumn as Column,
  CubbyTable as Table,
} from "./table-features";
import TableLayoutCustomizer from "./TableLayoutCustomizer";

const isStringHeader = (value: unknown): value is string =>
  typeof value === "string";

interface DataTableViewOptionsProps<TData extends RowData> {
  table: Table<TData>;
}

/**
 * Same derivation `LedgerFilters` uses: a column's own string `header` reads
 * better than its raw id ("Data quality", not "dataQuality"), and `humanize`
 * is only the fallback for headers that aren't plain strings (icons, JSX).
 * Column meta has no other honest signal to group columns by — `mobile.slot`
 * (title/subtitle/meta/trailing) exists to place fields on a phone card, not
 * to categorize a settings menu, and on `/products` it's unset (implicit
 * "hidden") for roughly half the columns, so grouping by it would dump most
 * of the list into one meaningless bucket. Search is what makes 26 items
 * navigable instead.
 */
export function columnLabel<TData extends RowData>(
  column: Column<TData, unknown>,
): string {
  const header = column.columnDef.header;
  return isStringHeader(header) ? header : humanize(column.id);
}

export function DataTableViewOptions<TData extends RowData>({
  table,
}: DataTableViewOptionsProps<TData>) {
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isCustomized = isTableLayoutCustomized(
    {
      columnOrder: table.state.columnOrder,
      columnPinning: table.state.columnPinning,
      columnVisibility: table.state.columnVisibility,
      columnSizing: table.state.columnSizing,
    },
    table.options.meta?.defaultLayout,
  );

  const triggerContent = (
    <>
      <Settings2 className="size-3.5" />
      Columns
      {isCustomized && (
        <span className="font-mono text-2xs tracking-normal text-muted-foreground normal-case">
          Custom
        </span>
      )}
    </>
  );

  if (isMobile) {
    return (
      <>
        <Button
          variant="ghost"
          size="default"
          className="text-muted-foreground hover:text-foreground"
          aria-haspopup="dialog"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
        >
          {triggerContent}
        </Button>
        <ResponsiveSheet
          open={mobileOpen}
          onOpenChange={setMobileOpen}
          title="Columns"
          description="Choose the column order, visibility, and pinned columns."
        >
          <div className="space-y-4">
            {isCustomized && (
              <p className="text-xs text-muted-foreground">
                Customized layout — restore defaults below
              </p>
            )}
            <TableLayoutCustomizer table={table} />
          </div>
        </ResponsiveSheet>
      </>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="default"
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        {triggerContent}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[75vh] w-[480px] overflow-y-auto"
      >
        {isCustomized && (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-2xs text-muted-foreground">
              Customized layout — restore defaults below
            </DropdownMenuLabel>
          </DropdownMenuGroup>
        )}
        <TableLayoutCustomizer table={table} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
