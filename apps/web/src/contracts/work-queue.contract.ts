import {
  workQueueHouseholdInput,
  workQueueOutSchema,
  workQueuePageInput,
} from "@cubby/schemas/work-queue";

import { defineContract, query } from "~/contracts/define";

export const workQueueContract = defineContract("workQueue", {
  list: query({
    mcp: {
      omit: "client_view",
      note: "Household routing overview; agents use the member-scoped queue",
    },
    input: workQueueHouseholdInput,
    output: workQueueOutSchema,
    readPolicy: "strong",
  }),
  forMember: query({
    input: workQueuePageInput,
    output: workQueueOutSchema,
    readPolicy: "strong",
  }),
});
