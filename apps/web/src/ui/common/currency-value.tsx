import { type ReactNode, useId, useState } from "react";

import { formatCurrency, formatExactCurrency } from "~/lib/number-format";
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

/** Rounded money shares the table's full-value spill and accessible tooltip. */
export function CurrencyValue({
  value,
  decimals,
  className,
  interactive = true,
}: {
  value: number;
  decimals?: number;
  className?: string;
  /** Editable values already have their own keyboard trigger. */
  interactive?: boolean;
}) {
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
