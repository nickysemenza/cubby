import {
  listStatementImportsInput,
  listStatementRowsInput,
  statementImportListOut,
  statementRowListOut,
  statementRowSummaryInput,
  statementRowSummaryOut,
} from "@cubby/schemas/statement-row";

import { defineContract, query } from "~/contracts/define";

export const statementRowContract = defineContract("statementRow", {
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
