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

import { defineContract, mutation, query } from "~/contracts/define";

export const statementRowContract = defineContract("statementRow", {
  previewCsv: query({
    mcp: {
      omit: "agent_twin",
      twin: "financialTransaction.previewStatementImport",
      note: "Local CSV parse in the Apple app",
    },
    native: "Preview local statement CSV in Apple apps using the shared parser",
    input: statementCsvFileInput,
    output: statementCsvPreviewOut,
    cache: { tags: [] },
  }),
  commitCsv: mutation({
    mcp: { omit: "agent_twin", twin: "statementRow.record" },
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
  // Agent-facing (MCP `finance_read`, `statement_rows`): off the HTTP API.
  /** Charges recorded twice under two identities (descriptor drift). */
  drift: query({
    http: false,
    input: findStatementRowDriftInput,
    output: findStatementRowDriftOut,
  }),
  /** Write judgment fields onto rows selected by id or by filter. */
  update: mutation({
    http: false,
    input: updateStatementRowsInput,
    output: statementRowWriteOut,
    invalidates: ["statementRow"],
  }),
  delete: mutation({
    http: false,
    input: deleteStatementRowsInput,
    output: statementRowWriteOut,
    invalidates: ["statementRow"],
  }),
});
