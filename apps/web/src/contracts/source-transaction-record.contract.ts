import {
  findSourceTransactionRecordDriftInput,
  findSourceTransactionRecordDriftOut,
  recordSourceTransactionRecordsInput,
  recordSourceTransactionRecordsOut,
  sourceTransactionRecordSummaryInput,
  sourceTransactionRecordSummaryOut,
} from "@cubby/schemas/source-transaction-record";
import {
  statementSuggestionPreviewInput,
  statementSuggestionPreviewOut,
} from "@cubby/schemas/statement-suggestion";

import { defineContract, mutation, query } from "~/contracts/define";

export const sourceTransactionRecordContract = defineContract(
  "sourceTransactionRecord",
  {
    previewSuggestion: query({
      mcp: {
        omit: "client_view",
        note: "Read-only preview of a Suggestions review draft",
      },
      readPolicy: "strong",
      transport: "post",
      input: statementSuggestionPreviewInput,
      output: statementSuggestionPreviewOut,
    }),
    record: mutation({
      input: recordSourceTransactionRecordsInput,
      output: recordSourceTransactionRecordsOut,
      invalidates: ["sourceTransactionRecord"],
    }),
    summary: query({
      readPolicy: "strong",
      input: sourceTransactionRecordSummaryInput,
      output: sourceTransactionRecordSummaryOut,
    }),
    /** Charges recorded twice under two identities (descriptor drift). */
    drift: query({
      input: findSourceTransactionRecordDriftInput,
      output: findSourceTransactionRecordDriftOut,
    }),
  },
);
