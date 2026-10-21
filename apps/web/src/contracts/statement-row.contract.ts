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
  statementCsvCommitInput,
  statementCsvCommitOut,
  statementCsvFileInput,
  statementCsvPreviewOut,
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
  previewCsv: query({
    mcp: {
      omit: "deferred_capability",
      note: "Parses a statement CSV with the shared parser",
    },
    native: "Preview local statement CSV in Apple apps using the shared parser",
    input: statementCsvFileInput,
    output: statementCsvPreviewOut,
    cache: { tags: [] },
  }),
  commitCsv: mutation({
    mcp: {
      omit: "deferred_capability",
      note: "Assigns accounts and creates FinancialTransactions or attaches observations; statement_rows.record only records evidence",
    },
    native: "Confirm statement CSV rows from Apple apps",
    input: statementCsvCommitInput,
    output: statementCsvCommitOut,
    invalidates: ["statementRow", "financialTransaction"],
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
