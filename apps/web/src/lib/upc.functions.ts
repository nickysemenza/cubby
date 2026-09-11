import { upcContract } from "~/contracts/upc.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const upc = defineOperationDomain(upcContract, {
  lookup: { tags: [["upc", "lookup"]] },
});
