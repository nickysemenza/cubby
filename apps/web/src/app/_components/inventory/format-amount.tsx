"use client";

import { Amount } from "~/codec/codec";
import { renderValueOrError } from "~/misc/result";
import { UnitMapping } from "~/schemas/unitmapping";
import { wasm } from "~/lib/wasm";
import { convertAmountToPrice } from "../units/univ-conversion";
import { WMeasure } from "@recipehub/recipebridge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import ValidInvalidIcon from "../icons/valid-invalid";

/**
 * Helper function for displaying amount and price
 */
export const showAmountAndPrice = (amount: Amount, mappings: UnitMapping[]) => {
  if (amount.unit === "each") {
    // todo
    amount.unit = "Whole";
  }
  if (mappings === undefined) {
    return "loading";
  }
  const price = convertAmountToPrice(amount, mappings);
  return (
    <div className="flex flex-col">
      <div>{renderValueOrError(price, (p) => wasm.format_amount(p))}</div>
      <div>{tryFormatMeasure(amount)}</div>
    </div>
  );
};

/**
 * Safely formats a measure, returning error string on failure
 */
export const tryFormatMeasure = (measure: WMeasure): string => {
  try {
    return wasm.format_amount(measure);
  } catch (error) {
    return `Error formatting measure: ${error}`;
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
        <p>{wasm.measure_kind({ unit: x, value: 1 })}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);
