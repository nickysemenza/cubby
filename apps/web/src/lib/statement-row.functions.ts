import {
  listStatementImportsInput,
  listStatementRowsInput,
  statementImportListOut,
  statementRowListOut,
  statementRowSummaryInput,
  statementRowSummaryOut,
} from "@cubby/schemas/statement-row";

import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const statementRow = defineOperationDomain("statementRow", {
  list: query({
    input: listStatementRowsInput,
    output: statementRowListOut,
    tags: [["statementRow", "list"]],
  }),
  summary: query({
    input: statementRowSummaryInput,
    output: statementRowSummaryOut,
    tags: [["statementRow", "summary"]],
  }),
  imports: query({
    input: listStatementImportsInput,
    output: statementImportListOut,
    tags: [["statementRow", "imports"]],
  }),
});
