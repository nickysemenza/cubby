import {
  filterOptionsInput,
  filterOptionsOut,
} from "@cubby/schemas/filter-options";

import { defineContract, query } from "~/contracts/define";

export const entityFilterOptionsContract = defineContract("entity", {
  filterOptions: query({
    input: filterOptionsInput,
    output: filterOptionsOut,
  }),
});
