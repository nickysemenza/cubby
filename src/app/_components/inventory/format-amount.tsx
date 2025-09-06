"use client";

import { Amount } from "~/codec/codec";
import { renderValueOrError } from "~/misc/result";
import { UnitMapping } from "~/schemas/unitmapping";
import { wasm } from "~/hooks/useWasm";
import { convertAmountToPrice } from "../units/univ-conversion";
import { WMeasure } from "recipebridge/pkg/recipebridge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import ValidInvalidIcon from "../icons/valid-invalid";

// Helper function for backward compatibility
export const showAmountAndPrice = (
  w: wasm,
  amount: Amount,
  mappings: UnitMapping[],
) => {
  if (amount.unit === "each") {
    // todo
    amount.unit = "Whole";
  }
  if (mappings === undefined) {
    return "loading";
  }
  const price = convertAmountToPrice(w, amount, mappings);
  return (
    <div className="flex flex-col">
      <div>{renderValueOrError(price, (p) => w.format_amount(p))}</div>
      <div>{tryFormatMeasure(w, amount)}</div>
    </div>
  );
};

// Helper function for backward compatibility
export const tryFormatMeasure = (w: wasm, measure: WMeasure) => {
  try {
    return w.format_amount(measure);
  } catch (error) {
    return (
      <div className="text-destructive">
        {"Error formatting measure: " + error}
      </div>
    );
  }
};

// Helper function for backward compatibility
export const getHoverableMeasureUnitIcon = (w: wasm, x: string) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger>
        <ValidInvalidIcon isValid={w.is_valid_unit(x, [])} />
      </TooltipTrigger>
      <TooltipContent>
        <p>{w.measure_kind({ unit: x, value: 1 })}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);
