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
        "Whether background work is healthy: stuck work with its raw failure, whether work is catching up, and when work last finished. A kind is stuck when work has been due for 30 minutes with no completion in that time, when it keeps failing, or when Apple-device work has no device. Use job.activity and job.queue to diagnose a stuck kind.",
      input: z.strictObject({}),
      output: workStatus,
      // Not entity roots: a status mounted in the shell must not refetch on every write.
      cache: { tags: [["run"], ["workQueue"]] },
    }),
    queue: query({
      exposure: "capability",
      description:
        "Actionable work (research, review, repair, Problems, waiting) across the household's work sources. Needs you is `executor: human` with `owner: @me`. An agent sees shared work and work routed only to its own member; private work belonging to another member is excluded before counts and pagination. Filters: `entity` (record type), `owner` (member shortcodes or `@me`; `ownerPresence: none` is unresolved routing), `family`, `executor` (automatic, agent, human, external), and `reason` (stable keys: data checks, problem keys, or source keys); each also takes its `…Exclude` key. `view` selects a saved view (automatic, agent, human, external, problems).",
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
