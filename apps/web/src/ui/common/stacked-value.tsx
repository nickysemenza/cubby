import type { Entity } from "@cubby/schemas/entity";
import { createContext, useContext } from "react";

import { cn } from "~/lib/utils";

/**
 * Set inside a desktop table cell, where values take their dense form: dates,
 * timestamps and entity links stack in two lines and a quality score drops
 * its "/100". Phone cards, ledgers and prose keep their one-line forms;
 * another surface opts in with the component's `stacked` prop. `linksTo` is
 * the entity whose icon the column header already paints.
 */
export const DenseCellContext = createContext<{
  linksTo: Entity | null;
} | null>(null);

/** Whether a value takes its dense form: `stacked` if given, else in a cell. */
export function useDenseCell(stacked?: boolean) {
  const cell = useContext(DenseCellContext);
  return stacked ?? cell !== null;
}

/** The entity whose icon this cell's column header paints, if any. */
export const useHeaderEntity = () =>
  useContext(DenseCellContext)?.linksTo ?? null;

/** A stacked value's muted second line: 11px on 13px. */
export const STACKED_SECONDARY_CLASS =
  "block truncate text-[0.6875rem] leading-[13px] font-normal text-muted-foreground no-underline";

/**
 * A value over a muted secondary line, both fitting one 32px table row
 * (15px + 13px). Secondary context reads as type hierarchy, not parentheses.
 */
export function StackedValue({
  primary,
  secondary,
  title,
  primarySpillText,
  secondarySpillText,
  className,
  suppressSecondaryHydrationWarning,
}: {
  primary: string;
  secondary: string | null;
  title?: string;
  primarySpillText?: string;
  secondarySpillText?: string;
  className?: string;
  /** Relative dates can cross a clock boundary between SSR and hydration. */
  suppressSecondaryHydrationWarning?: boolean;
}) {
  return (
    <span className={cn("block min-w-0", className)} title={title}>
      <span
        data-stacked-line=""
        data-cell-spill-text={primarySpillText}
        className="block truncate text-[0.8125rem] leading-[15px]"
      >
        {primary}
      </span>
      {secondary && (
        <span
          data-stacked-line=""
          data-cell-spill-text={secondarySpillText}
          className={STACKED_SECONDARY_CLASS}
          suppressHydrationWarning={suppressSecondaryHydrationWarning}
        >
          {secondary}
        </span>
      )}
    </span>
  );
}
