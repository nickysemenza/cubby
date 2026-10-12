import { createContext, useContext } from "react";

import { cn } from "~/lib/utils";

/**
 * True inside a desktop table cell. Dates and timestamps stack there by
 * default; phone cards, ledgers and prose keep their one-line forms.
 */
export const StackedCellContext = createContext(false);

export function useStackedCell(stacked: boolean | undefined) {
  const inCell = useContext(StackedCellContext);
  return stacked ?? inCell;
}

/**
 * A value over a muted secondary line, both fitting one 32px table row
 * (15px + 13px). Secondary context reads as type hierarchy, not parentheses.
 */
export function StackedValue({
  primary,
  secondary,
  title,
  className,
}: {
  primary: string;
  secondary: string | null;
  title?: string;
  className?: string;
}) {
  return (
    <span className={cn("block min-w-0", className)} title={title}>
      <span
        data-stacked-line=""
        className="block truncate text-[0.8125rem] leading-[15px]"
      >
        {primary}
      </span>
      {secondary && (
        <span
          data-stacked-line=""
          className="block truncate text-[0.6875rem] leading-[13px] text-muted-foreground"
        >
          {secondary}
        </span>
      )}
    </span>
  );
}
