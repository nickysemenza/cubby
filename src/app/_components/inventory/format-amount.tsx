"use client";

import { Amount } from "~/codec/codec";
import { renderValueOrError } from "~/misc/result";
import { UnitMapping } from "~/schemas/unitmapping";
import { wasm } from "~/wasmContext";
import { convertAmountToPrice } from "../units/univ-conversion";

export const formatAmount = (w: wasm, amount: Amount, mappings: UnitMapping[]) => {
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
            <div>{renderValueOrError(price, (p) => w.format_measure(p))}</div>
            <div>{w.format_amount(amount)}</div>
        </div>
    );
}