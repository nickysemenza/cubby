import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";

import { useCellActive, useCoarsePointer, useRowActive } from "./row-activity";
import { railCovers } from "./use-cell-spill";

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
 * An `overlay` rail reserves nothing: it mounts only in the hovered or
 * focused cell of the active row and sits over the cell's free edge, the
 * start of a right-aligned number or the end of text. It never paints over
 * a value: when the value is clipped (or its text reaches the rail) the rail
 * turns transparent and click-through in place, and the hover spill-over
 * draws its copy after the full value. Keyboard focus inside the rail still
 * reveals it. Reserved rails put 18px in every cell of 100 list columns.
 * Coarse pointers have no hover, so their rail stays in flow and visible.
 *
 * A floating frame nested in another (a relation workbench inside an
 * explanation) portals its controls into the outer rail. Regression: both
 * rails floated on the same spot and the ⓘ covered the workbench button.
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
  const cellActive = useCellActive();
  const coarse = useCoarsePointer();
  const host = useContext(FloatingRail);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const floating = overlay && !coarse;
  const nested = floating && host !== undefined;
  const floatingRailShown = floating && !nested && active && cellActive;
  const valueRef = useRef<HTMLSpanElement>(null);
  const railRef = useRef<HTMLSpanElement>(null);
  // Written to the DOM, not state. Regression: a `covers` state set here
  // re-rendered the cell inside commit and, after a viewport resize, hit
  // React's update-depth limit (#185) and crashed the page.
  useLayoutEffect(() => {
    const valueElement = valueRef.current;
    const rail = railRef.current;
    if (!floatingRailShown || !valueElement || !rail) return;
    rail.toggleAttribute(
      "data-rail-covers",
      valueElement.scrollWidth > valueElement.clientWidth + 1 ||
        railCovers(valueElement, rail),
    );
  }, [floatingRailShown, children]);
  const value = (
    <span ref={valueRef} data-cell-value="" className="min-w-0 flex-1 truncate">
      {children}
    </span>
  );
  return (
    <span
      data-cell-frame=""
      className={cn(
        "relative flex w-full min-w-0 items-center gap-0.5",
        className,
      )}
    >
      {floating ? (
        <FloatingRail.Provider value={slot}>{value}</FloatingRail.Provider>
      ) : (
        value
      )}
      {nested
        ? host && createPortal(trailing, host)
        : (!floating || floatingRailShown) && (
            <span
              ref={railRef}
              data-cell-rail=""
              className={cn(
                "flex shrink-0 items-center",
                floating &&
                  "absolute inset-y-0 end-0 my-auto h-fit rounded-sm bg-(--table-row-surface) shadow-[-6px_0_6px_var(--table-row-surface)] [td.text-right_&]:start-0 [td.text-right_&]:end-auto [td.text-right_&]:shadow-[6px_0_6px_var(--table-row-surface)]",
                floating &&
                  "data-rail-covers:pointer-events-none data-rail-covers:opacity-0 data-rail-covers:focus-within:pointer-events-auto data-rail-covers:focus-within:opacity-100",
              )}
            >
              {floating && <span ref={setSlot} className="contents" />}
              {trailing}
            </span>
          )}
    </span>
  );
}

/**
 * The rail slot of the enclosing floating frame: undefined outside one, null
 * while its row is inactive and the rail unmounted.
 */
const FloatingRail = createContext<HTMLElement | null | undefined>(undefined);

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
 *
 * A detail facts ledger has width to spare, so there the group hugs its value
 * and the pencil sits in flow right after it, revealed on row hover. A
 * full-width group pinned the pencil (and the editor anchored to it) to the
 * far edge of the value column and pushed the resolution caption onto its
 * own line.
 */
export const CELL_EDIT_GROUP_CLASS =
  "group/cell-edit relative flex w-full min-w-0 items-center in-data-[slot=basic-info-value]:w-auto in-data-[slot=basic-info-value]:gap-1";

export const CELL_EDIT_PENCIL_CLASS =
  "absolute inset-y-0 right-0 my-auto size-5 shrink-0 justify-center rounded-sm bg-muted p-0 opacity-0 shadow-[-6px_0_6px_var(--muted)] transition-opacity group-hover/cell-edit:opacity-100 focus-visible:opacity-100 pointer-coarse:static pointer-coarse:opacity-100 pointer-coarse:shadow-none in-data-[slot=basic-info-value]:static in-data-[slot=basic-info-value]:ms-0 in-data-[slot=basic-info-value]:bg-transparent in-data-[slot=basic-info-value]:shadow-none in-data-[slot=basic-info-value]:hover:bg-muted in-[.ledger-row:hover]:opacity-100";
