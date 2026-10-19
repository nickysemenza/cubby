import { type ReactNode, useId, useState } from "react";

import { formatCurrency, formatExactCurrency } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

/** Full currency evidence stays associated with its trigger for keyboard and assistive access. */
export function CurrencyTooltip({
  children,
  label,
  details,
  className,
  spillText,
}: {
  children: ReactNode;
  label: string;
  details: ReactNode;
  className?: string;
  spillText?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        render={<button type="button" aria-label={label} />}
        aria-describedby={open ? id : undefined}
        className={className}
        style={{ textAlign: "inherit" }}
        data-cell-spill-text={spillText}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent id={id} role="tooltip" className="break-all">
        {details}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Money reads in ink. Only a credit — a value whose sign is printed — takes
 * the positive tone, so a refund never reads as spend and spend never reads
 * as good news; a zero is a quiet fact.
 */
export function moneyToneClass(value: number): string | undefined {
  if (value < 0) return "text-positive";
  if (value === 0) return "text-muted-foreground";
  return undefined;
}

/** Rounded money shares the table's full-value spill and accessible tooltip. */
export function CurrencyValue({
  value,
  decimals,
  className: callerClassName,
  interactive = true,
  tone = true,
}: {
  value: number;
  decimals?: number;
  className?: string;
  /** Editable values already have their own keyboard trigger. */
  interactive?: boolean;
  /** Sign tone (credit positive, zero muted); off for totals and prose. */
  tone?: boolean;
}) {
  const className = cn(tone && moneyToneClass(value), callerClassName);
  const displayed = formatCurrency(value, decimals);
  const exact = formatExactCurrency(value);
  if (displayed === exact)
    return (
      <span className={className} title={exact}>
        {displayed}
      </span>
    );
  if (!interactive)
    return (
      <span
        className={className}
        title={`Full stored amount: ${exact}`}
        data-cell-spill-text={exact}
      >
        {displayed}
      </span>
    );
  return (
    <CurrencyTooltip
      label={`Full stored amount: ${exact}`}
      className={className}
      spillText={exact}
      details={`Full stored amount: ${exact}`}
    >
      {displayed}
    </CurrencyTooltip>
  );
}
