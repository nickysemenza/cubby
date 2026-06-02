import type { WAmount } from "@cubby/recipebridge";
import type { Amount } from "@cubby/schemas/codec";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { convertAmountToPrice } from "~/lib/recipe-costing";
import { wasm } from "~/lib/wasm";
import { renderValueOrError } from "~/misc/result";
import ValidInvalidIcon from "../icons/valid-invalid";

/**
 * Helper function for displaying amount and price
 */
export const showAmountAndPrice = (
  amount: Amount,
  mappings: UnitMapping[] | undefined,
) => {
  if (mappings === undefined) {
    return "loading";
  }

  // If no unit mappings exist, show amount only without attempting price conversion
  // This is expected for misc items and shouldn't show as an error
  if (mappings.length === 0) {
    return (
      <div className="flex flex-col">
        <div className="text-muted-foreground">—</div>
        <div>{tryFormatAmount(amount)}</div>
      </div>
    );
  }

  const price = convertAmountToPrice(amount, mappings);
  return (
    <div className="flex flex-col">
      <div>{renderValueOrError(price, (p) => tryFormatAmount(p))}</div>
      <div>{tryFormatAmount(amount)}</div>
    </div>
  );
};

/**
 * Safely formats a measure, returning error string on failure.
 * Preserves "each" unit - WASM normalizes to "whole" but we keep user's input.
 */
export const tryFormatAmount = (amount: WAmount): string => {
  try {
    const formatted = wasm.format_amount(amount);
    // WASM renders money with a trailing symbol ("0.01 $"); show it as proper
    // currency instead ("$0.01"), matching how amounts read everywhere else.
    const money = formatted.match(/^(.+?)\s*\$$/);
    if (money) {
      return `$${money[1]}`;
    }
    // Preserve "each" - WASM normalizes to "whole" but we want to keep user's input
    if (amount.unit === "each" && formatted.includes("whole")) {
      return formatted.replace(/\bwhole\b/g, "each");
    }
    return formatted;
  } catch (error) {
    return `Error formatting amount: ${error}`;
  }
};

/**
 * Helper function for rendering a hoverable unit icon with tooltip
 */
export const getHoverableMeasureUnitIcon = (x: string) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger>
        <ValidInvalidIcon isValid={wasm.is_valid_unit(x, [])} />
      </TooltipTrigger>
      <TooltipContent>
        <p>{wasm.amount_kind({ unit: x, value: 1 })}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);
