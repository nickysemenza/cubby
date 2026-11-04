import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { useState, type ReactNode } from "react";

import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

/** A labelled row of the Display popover: the control keeps its own menu. */
export function DisplayRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-(--control-height) items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 justify-end">{children}</div>
    </div>
  );
}

/**
 * How the records are shown: layout, sort, group and columns behind one control.
 * Every choice keeps its existing owner (the URL's view and groupBy, the table's
 * sorting and layout). Header menus still sort and group directly. A dot marks a
 * non-default arrangement, so nothing is hidden in here silently.
 */
export function DisplayMenu({
  children,
  columns,
  customized = false,
}: {
  children?: ReactNode;
  /** The table's column customizer; lists without a table omit it. */
  columns?: ReactNode;
  customized?: boolean;
}) {
  const [columnsOpen, setColumnsOpen] = useState(false);
  return (
    <>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="relative h-(--input-height) shrink-0 gap-1.5 text-sm"
            />
          }
        >
          <SlidersHorizontalIcon className="size-3.5" />
          Display
          {customized && (
            <span
              aria-hidden
              data-display-customized=""
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
            />
          )}
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-72 flex-col gap-1 p-2">
          {children}
          {columns && (
            <DisplayRow label="Columns">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-(--input-height) text-sm"
                onClick={() => setColumnsOpen(true)}
              >
                <GearSixIcon className="size-3.5" />
                Columns…
              </Button>
            </DisplayRow>
          )}
        </PopoverContent>
      </Popover>
      {columns && (
        <Overlay
          open={columnsOpen}
          onOpenChange={setColumnsOpen}
          title="Columns"
        >
          {columns}
        </Overlay>
      )}
    </>
  );
}
