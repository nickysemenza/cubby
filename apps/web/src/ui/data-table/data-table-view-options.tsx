import { humanize } from "@cubby/shared";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import type { RowData } from "@tanstack/react-table";
import { useState } from "react";

import { useIsMobile } from "~/ui/hooks/use-mobile";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

import { isTableLayoutCustomized } from "./column-layout";
import type {
  CubbyColumn as Column,
  CubbyTable as Table,
} from "./table-features";
import TableLayoutCustomizer from "./table-layout-customizer";

const isStringHeader = (value: unknown): value is string =>
  typeof value === "string";

interface DataTableViewOptionsProps<TData extends RowData> {
  table: Table<TData>;
}

/**
 * Same derivation `LedgerFilters` uses: a column's own string `header` reads
 * better than its raw id ("Data quality", not "dataQuality"), and `humanize`
 * is only the fallback for headers that aren't plain strings (icons, JSX).
 * The customizer groups columns only by explicit `columnGroup` metadata;
 * phone-card slots do not classify column meaning.
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
    table.state,
    table.options.meta?.defaultLayout,
  );

  const triggerContent = (
    <>
      <GearSixIcon className="size-3.5" />
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
          className="h-7.5 text-sm text-muted-foreground hover:text-foreground"
          aria-haspopup="dialog"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
        >
          {triggerContent}
        </Button>
        <Overlay
          placement="panel"
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
        </Overlay>
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
            className="h-7.5 text-sm text-muted-foreground hover:text-foreground"
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
