import type { Table } from "@tanstack/react-table";
import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/ui/sheet";
import type { FilterConfig } from "./columnHelpers";
import { HeaderFilter } from "./HeaderFilter";

interface MobileFilterSheetProps<TData> {
  table: Table<TData>;
}

/**
 * Filters on mobile.
 *
 * The desktop filter row lives in the table header, which the mobile card view
 * doesn't render — so until now a phone could see that a list was filtered
 * (via the toolbar chips) but had no way to change it.
 *
 * Every control is the SAME `HeaderFilter` the desktop row uses, reading the
 * same manifest-derived `meta.filterConfig`. That's the point of the manifest:
 * a filter declared once shows up here too, with the right control type, and
 * the two surfaces can't drift.
 */
export function MobileFilterSheet<TData>({
  table,
}: MobileFilterSheetProps<TData>) {
  const [open, setOpen] = useState(false);

  const filterable = table
    .getAllColumns()
    .filter((column) => column.columnDef.meta?.filterConfig)
    .map((column) => ({
      column,
      config: column.columnDef.meta?.filterConfig as FilterConfig,
    }));

  if (filterable.length === 0) return null;

  const activeCount = table.getState().columnFilters.length;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon-lg"
            className="relative shrink-0"
            aria-label={
              activeCount > 0 ? `Filters (${activeCount} active)` : "Filters"
            }
          />
        }
      >
        <SlidersHorizontal className="size-4" />
        {activeCount > 0 && (
          <Badge
            variant="default"
            className="absolute -top-1 -right-1 size-4 justify-center p-0 text-3xs"
          >
            {activeCount}
          </Badge>
        )}
      </SheetTrigger>

      <SheetContent side="bottom" className="max-h-[80svh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
        </SheetHeader>

        <Stack gap="md" className="p-4">
          {filterable.map(({ column, config }) => {
            const header = column.columnDef.header;
            return (
              <Stack key={column.id} gap="xs">
                <span className="font-mono text-2xs text-slate uppercase tracking-wider">
                  {typeof header === "string" ? header : column.id}
                </span>
                {/* The filter row's controls are sized for a dense desktop
                    header; on a phone they need a real touch target. */}
                <div className="[&_input]:h-9 [&_input]:text-sm">
                  <HeaderFilter column={column} filterConfig={config} />
                </div>
              </Stack>
            );
          })}

          <Row justify="between" gap="sm" className="pt-2">
            <Button
              variant="outline"
              onClick={() => table.resetColumnFilters()}
              disabled={activeCount === 0}
            >
              Clear all
            </Button>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </Row>
        </Stack>
      </SheetContent>
    </Sheet>
  );
}
