import {
  clearDataExceptionInput,
  dataQuality,
  setDataExceptionInput,
} from "@cubby/schemas/data-quality";

import { defineContract, mutation } from "~/contracts/define";

/**
 * Explicit negative knowledge on a Purchase or Product completeness check
 * (MCP `data_exception`); each write returns the recomputed dataQuality.
 */
export const dataQualityContract = defineContract("dataQuality", {
  setException: mutation({
    http: false,
    input: setDataExceptionInput,
    output: dataQuality,
    invalidates: ["purchase", "product"],
  }),
  clearException: mutation({
    http: false,
    input: clearDataExceptionInput,
    output: dataQuality,
    invalidates: ["purchase", "product"],
  }),
});
