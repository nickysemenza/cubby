import {
  filterOptionsInput,
  filterOptionsOut,
} from "@cubby/schemas/filter-options";

import { defineContract, query } from "~/contracts/define";

export const entityFilterOptionsContract = defineContract("entity", {
  filterOptions: query({
    mcp: { omit: "client_view" },
    input: filterOptionsInput,
    output: filterOptionsOut,
  }),
});
