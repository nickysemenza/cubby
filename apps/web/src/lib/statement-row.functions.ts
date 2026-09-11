import { statementRowContract } from "~/contracts/statement-row.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const statementRow = defineOperationDomain(statementRowContract, {
  list: { tags: [["statementRow", "list"]] },
  summary: { tags: [["statementRow", "summary"]] },
  imports: { tags: [["statementRow", "imports"]] },
});
