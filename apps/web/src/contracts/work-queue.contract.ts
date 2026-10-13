import {
  workQueueHouseholdInput,
  workQueueOutSchema,
  workQueuePageInput,
  workQueueRecordInput,
} from "@cubby/schemas/work-queue";

import { ENTITY_ROOT_TAGS, type CacheTag } from "~/contracts/cache-policy";
import { defineContract, query } from "~/contracts/define";

/**
 * The projection reads records, their related evidence and ownership, data
 * exceptions, Runs and findings (every entity root, `run` included), and
 * Problems diagnostics, so any of those writes must refresh it (a resolved
 * gap leaves the record strip at once).
 */
const WORK_QUEUE_TAGS: readonly CacheTag[] = [
  ...ENTITY_ROOT_TAGS,
  ["problems"],
];

export const workQueueContract = defineContract("workQueue", {
  list: query({
    mcp: {
      omit: "client_view",
      note: "Household routing overview; agents use the member-scoped queue",
    },
    input: workQueueHouseholdInput,
    output: workQueueOutSchema,
    readPolicy: "strong",
    cache: { tags: WORK_QUEUE_TAGS },
  }),
  forRecord: query({
    mcp: {
      omit: "client_view",
      note: "Household record-detail strip; agents use the member-scoped queue",
    },
    input: workQueueRecordInput,
    output: workQueueOutSchema,
    readPolicy: "strong",
    cache: { tags: WORK_QUEUE_TAGS, profile: "live-status" },
  }),
  forMember: query({
    input: workQueuePageInput,
    output: workQueueOutSchema,
    readPolicy: "strong",
  }),
});
