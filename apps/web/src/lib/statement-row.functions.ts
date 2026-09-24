import { statementRowContract } from "~/contracts/statement-row.contract";
import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const statementRow = defineOperationDomain(statementRowContract, {
  record: {
    invalidates: entityRipple("statementRow"),
  },
  list: { tags: [["statementRow", "list"]] },
  summary: { tags: [["statementRow", "summary"]] },
  imports: { tags: [["statementRow", "imports"]] },
});
