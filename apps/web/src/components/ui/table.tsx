
import * as React from "react";

import { cn } from "~/lib/utils";

type TableProps = React.ComponentProps<"table"> & {
  containerClassName?: string;
};

// `table-fixed` makes columns share the available width and truncate, so the
// table always fits its container instead of growing and forcing horizontal
// scroll. Pair with `min-w-0` cells (the default below) for clean truncation.
function Table({ className, containerClassName, ...props }: TableProps) {
  return (
    <div
      data-slot="table-container"
      className={cn("relative w-full overflow-x-auto", containerClassName)}
    >
      <table
        data-slot="table"
        className={cn("w-full table-fixed caption-bottom text-xs", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      // Ledger header: paper-surface band underlined by the 3px ink rule — the
      // "printed control sheet" column header.
      className={cn(
        "bg-card [&_tr]:border-b-[3px] [&_tr]:border-b-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t font-medium [&>tr]:last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        // `group/row` is the hover anchor cells reach for when a row-level hover
        // must drive something other than the row's own background — currently
        // VendorMark's desaturate-at-rest logo. Named so it can't be captured by
        // an unrelated `group` nested inside a cell.
        "group/row hover:bg-muted/50 data-[state=selected]:bg-[var(--row-selected)] data-[state=selected]:shadow-[inset_3px_0_0_var(--row-accent,var(--brand-ultramarine))] border-b transition-colors",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      // Column headers must name the column they head for a screen reader
      // walking cells. Spread last so the non-column `<th>`s that share this
      // primitive — the width-slack spacer — can pass
      // `scope={undefined}` rather than claiming to head a column.
      scope="col"
      className={cn(
        "text-slate h-10 px-2 text-left align-middle font-mono text-2xs font-semibold tracking-wider uppercase whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "min-w-0 p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,

};
