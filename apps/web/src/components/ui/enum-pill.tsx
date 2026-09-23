import type { CSSProperties, ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

type EnumPillStyle = CSSProperties & {
  "--enum-pill-color": string;
};

/**
 * The shared presentation for categorical and computed-status values.
 *
 * A quiet tint and boundary make the value read as one category without
 * repeating its color as a separate dot. Text remains the non-color cue, while
 * an optional domain icon can reinforce categories that already have one.
 */
export function EnumPill({
  color = "var(--slate)",
  icon,
  description,
  children,
  className,
}: {
  /** Any CSS color from the option roster or semantic status palette. */
  color?: string;
  icon?: ReactNode;
  /** The option's meaning, shown as a tooltip on the pill. */
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  const style: EnumPillStyle = {
    "--enum-pill-color": color,
    backgroundColor:
      "color-mix(in srgb, var(--enum-pill-color) 9%, var(--background))",
    borderColor:
      "color-mix(in srgb, var(--enum-pill-color) 30%, var(--border))",
    color:
      "color-mix(in srgb, var(--enum-pill-color) 65%, var(--foreground))",
  };

  const pill = (
    <span
      className={cn(
        "inline-flex h-5 max-w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-1.5 py-0.5 text-2xs font-medium leading-none",
        className,
      )}
      style={style}
    >
      {icon ? (
        <span aria-hidden className="flex shrink-0 items-center [&>svg]:size-2.5!">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
  if (!description) return pill;
  return (
    <Tooltip>
      <TooltipTrigger render={pill} />
      <TooltipContent side="top" className="max-w-xs">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}
