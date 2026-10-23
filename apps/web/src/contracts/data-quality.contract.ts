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
export const dataQualityContract = defineContract(
  "dataQuality",
  {
    setException: mutation({
      description:
        "Record why a fact is absent or a mismatch is expected. The note is required and should explain why the fact was not issued, is unavailable/not applicable, lacks sufficient detail, or why a mismatch is expected. Upserts by check without duplicates. Only after the available sources have been searched.",
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
      description:
        "Clear exactly one explicit exception; any still-missing fact immediately reappears as a gap.",
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
  },
  { exposure: "capability", mcpToolGroup: "data_exception" },
);
