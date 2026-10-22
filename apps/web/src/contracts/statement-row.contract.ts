import {
  deleteStatementRowsInput,
  findStatementRowDriftInput,
  findStatementRowDriftOut,
  statementRowWriteOut,
  updateStatementRowsInput,
  listStatementImportsInput,
  listStatementRowsInput,
  recordStatementRowsInput,
  recordStatementRowsOut,
  statementImportListOut,
  statementRowListOut,
  statementRowSummaryInput,
  statementRowSummaryOut,
} from "@cubby/schemas/statement-row";
import {
  statementSuggestionPreviewInput,
  statementSuggestionPreviewOut,
} from "@cubby/schemas/statement-suggestion";

import { defineContract, mutation, query } from "~/contracts/define";

export const statementRowContract = defineContract("statementRow", {
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
    input: recordStatementRowsInput,
    output: recordStatementRowsOut,
    invalidates: ["statementRow"],
  }),
  list: query({
    readPolicy: "strong",
    input: listStatementRowsInput,
    output: statementRowListOut,
  }),
  summary: query({
    readPolicy: "strong",
    input: statementRowSummaryInput,
    output: statementRowSummaryOut,
  }),
  // Statement rows drive imports and reconciliation against live data.
  imports: query({
    readPolicy: "strong",
    input: listStatementImportsInput,
    output: statementImportListOut,
  }),
  // Agent-facing (MCP `finance_read`, `statement_rows`).
  /** Charges recorded twice under two identities (descriptor drift). */
  drift: query({
    input: findStatementRowDriftInput,
    output: findStatementRowDriftOut,
  }),
  /** Write judgment fields onto rows selected by id or by filter. */
  update: mutation({
    input: updateStatementRowsInput,
    output: statementRowWriteOut,
    invalidates: ["statementRow"],
  }),
  delete: mutation({
    input: deleteStatementRowsInput,
    output: statementRowWriteOut,
    invalidates: ["statementRow"],
  }),
});
