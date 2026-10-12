import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { useCoarsePointer, useRowActive } from "./row-activity";

/**
 * One anatomy for every decorated table cell: a value slot that truncates
 * with an ellipsis, then a rail of fixed-size affordances (explanation,
 * relation workbench, resolution badge, suggestion mark).
 *
 * Regression: decorations used to be appended as bare flex siblings of a
 * `min-w-0` value that never clipped, so in a narrow column the text spilled
 * out under the icon ("$2.ⓘ99"). The value slot owns the clip; a reserved
 * rail never shrinks, lines up at the column's end edge, and sizing adds its
 * width to the column.
 *
 * An `overlay` rail reserves nothing: it mounts only on the active row and
 * sits over the cell's free edge, the start of a right-aligned number or the
 * end of text, where it covers a clipped tail that the hover spill-over then
 * shows in full. Reserved rails put 18px in every cell of 100 list columns.
 * Coarse pointers have no hover, so their rail stays in flow and visible.
 */
export function CellFrame({
  children,
  trailing,
  overlay = false,
  className,
}: {
  children: ReactNode;
  trailing: ReactNode;
  overlay?: boolean;
  className?: string;
}) {
  const active = useRowActive();
  const coarse = useCoarsePointer();
  const floating = overlay && !coarse;
  return (
    <span
      data-cell-frame=""
      className={cn(
        "relative flex w-full min-w-0 items-center gap-0.5",
        className,
      )}
    >
      <span data-cell-value="" className="min-w-0 flex-1 truncate">
        {children}
      </span>
      {(!floating || active) && (
        <span
          data-cell-rail=""
          className={cn(
            "flex shrink-0 items-center",
            floating &&
              "absolute inset-y-0 end-0 my-auto h-fit rounded-sm bg-(--table-row-surface) shadow-[-6px_0_6px_var(--table-row-surface)] [td.text-right_&]:start-0 [td.text-right_&]:end-auto [td.text-right_&]:shadow-[6px_0_6px_var(--table-row-surface)]",
          )}
        >
          {trailing}
        </span>
      )}
    </span>
  );
}

/** Width of one rail affordance plus its gap; column sizing reserves this. */
export const CELL_RAIL_SLOT_PX = 18;

/**
 * Icon-only rail control: 16px square with a 10px glyph, always visible,
 * quiet until hovered. Coarse pointers keep the 44px touch floor.
 */
export const CELL_RAIL_BUTTON_CLASS =
  "size-4 shrink-0 [&_svg]:size-2.5 rounded-sm text-muted-foreground/70 hover:bg-muted hover:text-foreground focus-visible:text-foreground";

/**
 * Wrapper for a value with an icon-only edit pencil. The pencil overlays the
 * value's trailing edge on hover/focus instead of reserving width it only
 * uses on hover — the reserved-but-invisible pencil is what squeezed narrow
 * money and date columns. Touch has no hover, so coarse pointers keep the
 * pencil in flow and visible.
 */
export const CELL_EDIT_GROUP_CLASS =
  "group/cell-edit relative flex w-full min-w-0 items-center";

export const CELL_EDIT_PENCIL_CLASS =
  "absolute inset-y-0 right-0 my-auto size-5 shrink-0 justify-center rounded-sm bg-muted p-0 opacity-0 shadow-[-6px_0_6px_var(--muted)] transition-opacity group-hover/cell-edit:opacity-100 focus-visible:opacity-100 pointer-coarse:static pointer-coarse:opacity-100 pointer-coarse:shadow-none";
