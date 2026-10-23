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

export const workQueueContract = defineContract(
  "workQueue",
  {
    list: query({
      note: "Household routing overview; agents use the member-scoped queue",
      input: workQueueHouseholdInput,
      output: workQueueOutSchema,
      readPolicy: "strong",
      cache: { tags: WORK_QUEUE_TAGS },
    }),
    forRecord: query({
      note: "Household record-detail strip; agents use the member-scoped queue",
      input: workQueueRecordInput,
      output: workQueueOutSchema,
      readPolicy: "strong",
      cache: { tags: WORK_QUEUE_TAGS, profile: "live-status" },
    }),
    forMember: query({
      exposure: "capability",
      description:
        "Actionable research, review and repair work available to the connected member, including shared work. Private source and account work belonging only to another member is excluded before counts and pagination. Routing follows current evidence ownership; unresolved private ownership requires household review.",
      input: workQueuePageInput,
      output: workQueueOutSchema,
      readPolicy: "strong",
    }),
  },
  { exposure: "view", mcpToolGroup: "activity" },
);
