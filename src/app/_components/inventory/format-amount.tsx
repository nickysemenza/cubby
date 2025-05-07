"use client";

import { Amount } from "~/codec/codec";
import { renderValueOrError } from "~/misc/result";
import { UnitMapping } from "~/schemas/unitmapping";
import { wasm } from "~/wasmContext";
import { convertAmountToPrice } from "../units/univ-conversion";
import { WMeasure } from "recipebridge/pkg/recipebridge";

export const showAmountAndPrice = (
  w: wasm,
  amount: Amount,
  mappings: UnitMapping[],
) => {
  if (amount.unit === "each") {
    // todo
    amount.unit = "Whole";
  }
  if (w === undefined || mappings === undefined) {
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

export const tryFormatMeasure = (w: wasm, measure: WMeasure) => {
  try {
    return w.format_amount(measure);
  } catch (error) {
    return (
      <div className="text-red-400">{"Error formatting measure :" + error}</div>
    );
  }
};
