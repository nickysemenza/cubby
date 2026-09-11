import { relatedDataContract } from "~/contracts/related-data.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const relatedData = defineOperationDomain(relatedDataContract, {
  previews: { tags: [["relatedData", "previews"]] },
  branch: { tags: [["relatedData", "branch"]] },
  options: { tags: [["relatedData", "options"]] },
  summary: { tags: [["relatedData", "summary"]] },
});
