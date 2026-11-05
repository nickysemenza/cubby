import type { Entity } from "@cubby/schemas/entity";
import { cn } from "cn";
import { createContext, useContext, type ReactNode } from "react";

/**
 * Set inside a desktop table cell, where values take their dense form: dates
 * take their compact parts and a quality score drops its "/100". `table.css`
 * lays a stacked value on one line at 24px rows; 32px surfaces (coarse pointers,
 * hosted native workspaces) keep its two lines. Identity cells always retain a
 * single name line. Phone cards, ledgers and prose keep their one-line forms;
 * another surface opts in with the component's `stacked` prop. `linksTo` is
 * the entity whose icon the column header already paints.
 */
export const DenseCellContext = createContext<{
  linksTo: Entity | null;
  /** RTable identity columns never add secondary lines or wrap the name. */
  identity?: boolean;
} | null>(null);

export const useIdentityCell = () =>
  useContext(DenseCellContext)?.identity === true;

/** Whether a value takes its dense form: `stacked` if given, else in a cell. */
export function useDenseCell(stacked?: boolean) {
  const cell = useContext(DenseCellContext);
  return cell?.identity ? false : (stacked ?? cell !== null);
}

/** A stacked value's muted second line. */
const STACKED_SECONDARY_CLASS =
  "block truncate text-xs leading-[13px] font-normal text-muted-foreground no-underline";

/**
 * A value over a muted secondary line, both fitting one 32px table row
 * (15px + 13px). Secondary context reads as type hierarchy, not parentheses.
 * Inside a dense cell at 24px rows the two share one line ("Oct 13 · 3mo ago").
 */
export function StackedValue({
  primary,
  secondary,
  title,
  primarySpillText,
  secondarySpillText,
  className,
  secondaryClassName,
  suppressSecondaryHydrationWarning,
}: {
  primary: string;
  /** Muted context: text, or a compact record link naming the owner. */
  secondary: ReactNode;
  title?: string;
  primarySpillText?: string;
  secondarySpillText?: string;
  className?: string;
  /** Replaces the muted tone of the second line (an overdue date). */
  secondaryClassName?: string;
  /** Relative dates can cross a clock boundary between SSR and hydration. */
  suppressSecondaryHydrationWarning?: boolean;
}) {
  const identity = useIdentityCell();
  const cell = useContext(DenseCellContext);
  return (
    <span
      data-stacked-value={cell ? "" : undefined}
      className={cn("block min-w-0", className)}
      title={title}
    >
      <span
        data-stacked-line=""
        data-cell-spill-text={primarySpillText}
        className="block truncate text-sm leading-[15px] tabular-nums"
      >
        {primary}
      </span>
      {!identity && secondary != null && secondary !== "" && (
        <span
          data-stacked-line=""
          data-cell-spill-text={secondarySpillText}
          className={cn(STACKED_SECONDARY_CLASS, secondaryClassName)}
          suppressHydrationWarning={suppressSecondaryHydrationWarning}
        >
          {secondary}
        </span>
      )}
    </span>
  );
}
