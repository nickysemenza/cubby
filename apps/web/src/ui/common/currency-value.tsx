import { formatCurrency, formatExactCurrency } from "~/lib/number-format";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

/** Rounded money shares the table's full-value spill and keyboard-accessible tooltip. */
export function CurrencyValue({
  value,
  decimals,
  className,
}: {
  value: number;
  decimals?: number;
  className?: string;
}) {
  const displayed = formatCurrency(value, decimals);
  const exact = formatExactCurrency(value);
  if (displayed === exact)
    return (
      <span className={className} title={exact}>
        {displayed}
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Full stored amount: ${exact}`}
            className={className}
            data-cell-spill-text={exact}
          />
        }
      >
        {displayed}
      </TooltipTrigger>
      <TooltipContent className="break-all">
        Full stored amount: {exact}
      </TooltipContent>
    </Tooltip>
  );
}
