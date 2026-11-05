import { cn } from "cn";
import { useContext, type FC } from "react";

import { formatText } from "~/lib/display-format";
import { DenseCellContext } from "~/ui/values/stacked-value";

interface NoneValueProps {
  className?: string;
  /** Hover text explaining why the value is absent. */
  title?: string;
}

/** The one muted tone of the empty mark, shared by named-state siblings. */
export const NONE_VALUE_TONE = "text-muted-foreground/60";

/**
 * The one empty mark. A desktop table cell leaves an empty value blank at
 * rest; inside an editable cell's trigger it reveals a faint "Add…" while the
 * row is hovered or the trigger is focused, without adding a pointer target.
 * Named states (loading, failed, not applicable, unknown) render their own
 * words and never come through here.
 */
export const NoneValue: FC<NoneValueProps> = ({ className, title }) => {
  const cell = useContext(DenseCellContext);
  if (cell)
    return (
      <span
        data-none-value=""
        title={title}
        className={cn(NONE_VALUE_TONE, "select-none", className)}
      >
        <span className="hidden opacity-0 transition-opacity duration-(--brand-motion-fast) in-data-cell-edit-trigger:inline in-[[data-cell-edit-trigger]:focus]:opacity-100 in-[tr:hover]:opacity-100">
          Add…
        </span>
      </span>
    );
  return (
    <span
      data-none-value=""
      title={title}
      className={cn(NONE_VALUE_TONE, "select-none", className)}
    >
      {formatText(undefined)}
    </span>
  );
};
