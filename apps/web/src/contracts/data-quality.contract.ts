import {
  clearDataExceptionInput,
  dataQuality,
  setDataExceptionInput,
} from "@cubby/schemas/data-quality";

import { defineContract, mutation } from "~/contracts/define";

/**
 * Explicit negative knowledge on a completeness check of any exceptions-enabled
 * entity (product, vendor, purchase, financialTransaction, expense)
 * (MCP `data_exception`); each write returns the recomputed dataQuality.
 */
export const dataQualityContract = defineContract("dataQuality", {
  setException: mutation({
    native: "Accept a data gap as a recorded exception",
    input: setDataExceptionInput,
    output: dataQuality,
    invalidates: [
      "product",
      "vendor",
      "purchase",
      "financialTransaction",
      "expense",
    ],
  }),
  clearException: mutation({
    native: "Clear a recorded data exception",
    input: clearDataExceptionInput,
    output: dataQuality,
    invalidates: [
      "product",
      "vendor",
      "purchase",
      "financialTransaction",
      "expense",
    ],
  }),
});
