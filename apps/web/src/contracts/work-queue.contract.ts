import {
  workQueueHouseholdInput,
  workQueueOutSchema,
  workQueuePageInput,
  workQueueRecordInput,
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
  forRecord: query({
    mcp: {
      omit: "client_view",
      note: "Household record-detail strip; agents use the member-scoped queue",
    },
    input: workQueueRecordInput,
    output: workQueueOutSchema,
    readPolicy: "strong",
  }),
  forMember: query({
    input: workQueuePageInput,
    output: workQueueOutSchema,
    readPolicy: "strong",
  }),
});
