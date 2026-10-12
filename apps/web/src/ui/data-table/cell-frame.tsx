import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * One anatomy for every decorated table cell: a value slot that truncates
 * with an ellipsis, then an adjacent rail of fixed-size affordances
 * (explanation, relation workbench, resolution badge, suggestion mark).
 *
 * Regression: decorations used to be appended as bare flex siblings of a
 * `min-w-0` value that never clipped, so in a narrow column the text spilled
 * out under the icon ("$2.ⓘ99"). The value slot owns the clip; the rail never
 * shrinks. The value slot takes the remaining width, so every row's rail
 * lines up at the column's end edge while the column itself hugs its widest
 * value plus rail; a right-aligned (numeric) cell ends its value against the
 * rail. Long values shrink before the rail, which never gives up its width.
 */
export function CellFrame({
  children,
  trailing,
  className,
}: {
  children: ReactNode;
  trailing: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-cell-frame=""
      className={cn("flex w-full min-w-0 items-center gap-0.5", className)}
    >
      <span data-cell-value="" className="min-w-0 flex-1 truncate">
        {children}
      </span>
      <span data-cell-rail="" className="flex shrink-0 items-center">
        {trailing}
      </span>
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
