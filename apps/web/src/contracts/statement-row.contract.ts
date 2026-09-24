import {
  listStatementImportsInput,
  listStatementRowsInput,
  recordStatementRowsInput,
  recordStatementRowsOut,
  statementImportListOut,
  statementRowListOut,
  statementRowSummaryInput,
  statementRowSummaryOut,
} from "@cubby/schemas/statement-row";

import { defineContract, mutation, query } from "~/contracts/define";

export const statementRowContract = defineContract("statementRow", {
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
