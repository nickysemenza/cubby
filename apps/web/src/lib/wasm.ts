import * as instance from "@cubby/recipebridge";

import { instrumentWasm, type ImmutableWasm } from "~/lib/wasm-runtime";

/** Common capabilities available in both browser and Worker builds. */
export const wasm: ImmutableWasm<typeof instance> = instrumentWasm(instance);

/** Cheap formatters bypass tracing and JSON-keyed memoization. */
export const wasmFormat = {
  format_currency: instance.format_currency,
  format_number: instance.format_number,
  format_count: instance.format_count,
  format_plain_date: instance.format_plain_date,
  format_text: instance.format_text,
  format_compact_estimate: instance.format_compact_estimate,
  format_estimate: instance.format_estimate,
  format_kcal: instance.format_kcal,
  format_currency_range: instance.format_currency_range,
};
