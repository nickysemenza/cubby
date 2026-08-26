import {
  type FilterOptionsInput,
  filterOptionsInput,
  filterOptionsOut,
} from "@cubby/schemas/filter-options";
import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const entityFilterOptions = defineOperationDomain("entity", {
  filterOptions: query({
    input: filterOptionsInput,
    output: filterOptionsOut,
    tags: [["entity", "filterOptions"]],
  }),
});

export type { FilterOptionsInput };
