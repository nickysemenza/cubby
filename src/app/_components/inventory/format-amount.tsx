"use client";

import { Amount } from "~/codec/codec";
import { renderValueOrError } from "~/misc/result";
import { UnitMapping } from "~/schemas/unitmapping";
import { useWasm, wasm } from "~/hooks/useWasm";
import { convertAmountToPrice } from "../units/univ-conversion";
import { WMeasure } from "recipebridge/pkg/recipebridge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import ValidInvalidIcon from "../icons/valid-invalid";
import { useMemo } from "react";

// Component version with hook
export const AmountAndPrice = ({
  amount,
  mappings,
}: {
  amount: Amount;
  mappings: UnitMapping[];
}) => {
  const w = useWasm();

  const formattedAmount = useMemo(() => {
    if (amount.unit === "each") {
      // todo: handle in a more robust way
      const updatedAmount = { ...amount, unit: "Whole" };
      if (mappings === undefined) {
        return "loading";
      }
      const price = convertAmountToPrice(w, updatedAmount, mappings);
      return (
        <div className="flex flex-col">
          <div>{renderValueOrError(price, (p) => w.format_amount(p))}</div>
          <div>{tryFormatMeasure(w, updatedAmount)}</div>
        </div>
      );
    } else {
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
    }
  }, [amount, mappings, w]);

  return formattedAmount;
};

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

// React hook for formatting a measure
export const useTryFormatMeasure = () => {
  const w = useWasm();

  return (measure: WMeasure) => {
    try {
      return w.format_amount(measure);
    } catch (error) {
      return (
        <div className="text-red-400">
          {"Error formatting measure: " + error}
        </div>
      );
    }
  };
};

// Helper function for backward compatibility
export const tryFormatMeasure = (w: wasm, measure: WMeasure) => {
  try {
    return w.format_amount(measure);
  } catch (error) {
    return (
      <div className="text-red-400">{"Error formatting measure: " + error}</div>
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
