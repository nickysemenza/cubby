import {
  workQueueInput,
  workQueueOutSchema,
  workQueueRecordInput,
} from "@cubby/schemas/work-queue";
import { workStatus } from "@cubby/schemas/work-status";
import { z } from "zod";

import { ENTITY_ROOT_TAGS, type CacheTag } from "~/contracts/cache-policy";
import { defineContract, query } from "~/contracts/define";

/**
 * The work sources read records, their related evidence and ownership, data
 * exceptions, Runs, findings and Problems diagnostics (every entity root,
 * `run` included), so any of those writes must refresh it (a resolved gap
 * leaves the record strip at once).
 */
const WORK_QUEUE_TAGS: readonly CacheTag[] = [
  ...ENTITY_ROOT_TAGS,
  ["problems"],
  // Suggestion and connection reviews refresh the pending-suggestions source.
  ["workQueue"],
];

export const workQueueContract = defineContract(
  "workQueue",
  {
    status: query({
      exposure: "capability",
      description:
        "Kernel work that is stuck, catching up, or finished. Inspect a record with machinery.read for its scopes, asks, passes and raw failures.",
      input: z.strictObject({}),
      output: workStatus,
      // Not entity roots: a status mounted in the shell must not refetch on every write.
      cache: { tags: [["run"], ["workQueue"]] },
    }),
    queue: query({
      exposure: "internal",
      description:
        "Live source projection for the browser work list, with entity, owner, family, executor and reason filters.",
      input: workQueueInput,
      output: workQueueOutSchema,
      cache: { tags: WORK_QUEUE_TAGS },
    }),
    forRecord: query({
      note: "Household record-detail strip; agents filter the queue instead",
      input: workQueueRecordInput,
      output: workQueueOutSchema,
      cache: { tags: WORK_QUEUE_TAGS, profile: "live-status" },
    }),
  },
  { exposure: "view", mcpToolGroup: "activity" },
);
