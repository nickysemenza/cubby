import {
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
    native: "Preview local statement CSV in Apple apps using the shared parser",
    input: statementCsvFileInput,
    output: statementCsvPreviewOut,
  }),
  commitCsv: mutation({
    native: "Confirm statement CSV rows from Apple apps",
    input: statementCsvCommitInput,
    output: statementCsvCommitOut,
  }),
  record: mutation({
    input: recordStatementRowsInput,
    output: recordStatementRowsOut,
  }),
  list: query({
    input: listStatementRowsInput,
    output: statementRowListOut,
  }),
  summary: query({
    input: statementRowSummaryInput,
    output: statementRowSummaryOut,
  }),
  imports: query({
    input: listStatementImportsInput,
    output: statementImportListOut,
  }),
});
