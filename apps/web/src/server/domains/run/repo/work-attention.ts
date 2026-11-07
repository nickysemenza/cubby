import { imageProcessingJobState } from "@cubby/schemas/image-processing";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { sql, type SQL } from "drizzle-orm";

import {
  evaluationRosterExists,
  evaluationRecoveryExists,
} from "~/server/ai/evaluation/repo/evaluation-tally";
import { related } from "~/server/db/helpers/related";
import { imageProcessingJob } from "~/server/db/retained-tables";
import { runHasLiveJobs } from "~/server/generic/jobs/repo/job-reads";

const RUN = runStatus.enum;

/** Run states the work queue treats as needing a person. */
export const attentionStatePredicate = (state: SQL): SQL =>
  sql`${state} IN (${RUN.paused}, ${RUN.paused_auth}, ${RUN.paused_offline}, ${RUN.needs_review}, ${RUN.failed}, ${RUN.dispatch_failed})`;

/** Permanent coordinator retirement closes execution recovery, not source review. */
export const retiredRunPredicate = (retiredAt: SQL): SQL<boolean> =>
  sql<boolean>`${retiredAt} IS NOT NULL`;

/** Explicit member stops remain in history without requesting recovery. */
export const memberStoppedRunPredicate = (failureCode: SQL): SQL<boolean> =>
  sql<boolean>`(${failureCode} IS NOT DISTINCT FROM ${"user_cancelled"} OR ${failureCode} IS NOT DISTINCT FROM ${"dispatch_aborted"})`;

/** Settled AI history closes recovery only; it never rewrites the failed Run. */
function settledAiRunPredicate(input: {
  id: SQL;
  purpose: SQL;
  status: SQL;
  failureCode: SQL;
}): SQL<boolean> {
  const owned = { runId: input.id, source: "owned" } as const;
  const requested = { runId: input.id, source: "requested" } as const;
  return sql<boolean>`(${input.purpose} = ${runPurpose.enum.ai_refresh}
    AND ${input.status} = ${RUN.failed}
    AND ${input.failureCode} IS NOT DISTINCT FROM ${"ai_work_failed"}
    AND ${evaluationRosterExists(owned)}
    AND NOT ${evaluationRecoveryExists(owned)}
    AND NOT ${evaluationRecoveryExists(requested)}
    AND NOT ${runHasLiveJobs(input.id)}
    AND NOT ${related(
      imageProcessingJob,
      (item) => sql`${item.runId} = ${input.id}`,
    )
      .where(
        (item) =>
          sql`${item.state} NOT IN (${imageProcessingJobState.enum.ready}, ${imageProcessingJobState.enum.skipped})`,
      )
      .exists()})`;
}

/** Shared stopped-state recovery policy; stalled execution and source review stay independent. */
export function stoppedRunRecoveryPredicate(input: {
  id: SQL;
  purpose: SQL;
  status: SQL;
  failureCode: SQL;
  retiredAt: SQL;
}): SQL<boolean> {
  return sql<boolean>`(NOT ${memberStoppedRunPredicate(input.failureCode)}
    AND NOT ${retiredRunPredicate(input.retiredAt)}
    AND NOT ${settledAiRunPredicate(input)})`;
}
