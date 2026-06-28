import type { WAmount } from "@cubby/recipebridge";
import type { Amount } from "@cubby/schemas/codec";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { ReadonlyDeep } from "type-fest";
import { NoneValue } from "~/components/ui/none-value";
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
        <NoneValue />
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
 * Re-attaches "each" - WASM renders bare counts (Unit::Whole) unit-less.
 */
export const tryFormatAmount = (
  // Accepts both the engine's WAmount (snake `upper_value`) and the persisted
  // Amount (camel `upperValue`) so the written-amount cell and the resolved
  // cost/weight cells both render ranges ("2 - 3 cup").
  amount: ReadonlyDeep<{
    value: number;
    unit: string;
    upper_value?: number;
    upperValue?: number;
  }>,
): string => {
  try {
    const upper = amount.upper_value ?? amount.upperValue;
    const formatted = wasm.format_amount({
      value: amount.value,
      unit: amount.unit,
      ...(upper != null ? { upper_value: upper } : {}),
    });
    // "each" parses to Unit::Whole, which renders unit-less ("3", "2 - 4");
    // re-attach the user's "each" so it stays visible ("3 each", "2 - 4 each").
    if (amount.unit === "each") {
      return `${formatted} each`;
    }
    return formatted;
  } catch (error) {
    return `Error formatting amount: ${error}`;
  }
};

/** Format a parsed ingredient's amounts (e.g. "1.333 cup, 173 g"), joined. */
export const formatAmounts = (
  amounts: ReadonlyDeep<WAmount[]>,
  sep = ", ",
): string => amounts.map(tryFormatAmount).join(sep);

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
