import { entityFilterOptionsContract } from "~/contracts/entity-filter-options.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const entityFilterOptions = defineOperationDomain(
  entityFilterOptionsContract,
  {
    filterOptions: {
      tags: [["entity", "filterOptions"]],
    },
  },
);
