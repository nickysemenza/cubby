import { cookbookContract } from "~/contracts/cookbook.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const cookbook = defineOperationDomain(cookbookContract, {
  list: {
    tags: [["cookbook"]],
    cache: "browse",
  },
  detail: {
    tags: [["cookbook"]],
  },
});
