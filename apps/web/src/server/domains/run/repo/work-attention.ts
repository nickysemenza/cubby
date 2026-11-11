import { imageProcessingJobState } from "@cubby/schemas/image-processing";
import { MAIL_DISCOVERY_ADMISSION_WAIT } from "@cubby/schemas/mailbox-research";
import { photoGroupProposalState } from "@cubby/schemas/photo-import-run";
import {
  RUN_KINDS,
  runPurpose,
  runStatus,
  runTrigger,
  type RunKindDeclaration,
} from "@cubby/schemas/run-fields";
import { eq, notInArray, sql, type SQL } from "drizzle-orm";

import {
  evaluationRosterExists,
  evaluationRecoveryExists,
} from "~/server/ai/evaluation/repo/evaluation-tally";
import { textArrayParam } from "~/server/db/helpers/query";
import { related } from "~/server/db/helpers/related";
import { imageProcessingJob } from "~/server/db/retained-tables";
import { activeFindingSql } from "~/server/domains/run/repo/finding-expiry";
import {
  runHasLiveJobs,
  runHasLiveExecution,
} from "~/server/generic/jobs/repo/job-reads";

const RUN = runStatus.enum;

/** A queued discovery is automatic demand only while its canonical generation remains live. */
export function queuedMailDiscoveryPredicate(input: {
  id: SQL;
  purpose: SQL;
  status: SQL;
  failureCode: SQL;
  progress: SQL;
}): SQL<boolean> {
  return sql<boolean>`CASE WHEN ${input.purpose} = ${runPurpose.enum.mail_discovery}
    AND ${input.status} = ${RUN.paused} AND ${input.failureCode} = ${MAIL_DISCOVERY_ADMISSION_WAIT}
    THEN ${runHasLiveExecution({ id: input.id, purpose: input.purpose, generation: sql`${input.progress}->>'attempt'` })}
    ELSE false END`;
}
const historicalRoutineStepPurposes = Object.entries(RUN_KINDS).flatMap(
  ([purpose, declaration]) => {
    const kind: RunKindDeclaration = declaration;
    return kind.historical && kind.routine && kind.steps && !kind.execution
      ? [purpose]
      : [];
  },
);

const unresolvedImageWorkExists = (id: SQL) =>
  related(imageProcessingJob, (item) => eq(item.runId, id))
    .where((item) =>
      notInArray(item.state, [
        imageProcessingJobState.enum.ready,
        imageProcessingJobState.enum.skipped,
      ]),
    )
    .exists();

/** Run states the work queue treats as needing a person. */
export const attentionStatePredicate = (state: SQL): SQL =>
  sql`${state} IN (${RUN.paused}, ${RUN.paused_auth}, ${RUN.paused_offline}, ${RUN.needs_review}, ${RUN.failed}, ${RUN.dispatch_failed})`;

/** Permanent coordinator retirement closes execution recovery, not source review. */
export const retiredRunPredicate = (retiredAt: SQL): SQL<boolean> =>
  sql<boolean>`${retiredAt} IS NOT NULL`;

/** Explicit member stops remain in history without requesting recovery. */
export const memberStoppedRunPredicate = (failureCode: SQL): SQL<boolean> =>
  sql<boolean>`(${failureCode} IS NOT DISTINCT FROM ${"user_cancelled"} OR ${failureCode} IS NOT DISTINCT FROM ${"dispatch_aborted"})`;

/** A historical scheduled executor is history only when no retained obligation remains. */
export function historicalRoutineRunPredicate(input: {
  id: SQL;
  purpose: SQL;
  status: SQL;
  trigger: SQL;
  endedAt: SQL;
  failureCode: SQL;
}): SQL<boolean> {
  if (!historicalRoutineStepPurposes.length) return sql<boolean>`false`;
  // CASE keeps obligation probes off unrelated Run kinds on every Work poll.
  return sql<boolean>`CASE WHEN ${input.purpose} = ANY(${textArrayParam(historicalRoutineStepPurposes)})
    AND ${input.trigger} = ${runTrigger.enum.scheduled} AND ${input.endedAt} IS NOT NULL
    AND ${input.status} IN (${RUN.failed}, ${RUN.dispatch_failed}, ${RUN.needs_review})
    AND ${input.failureCode} IS DISTINCT FROM 'execution_limit'
  THEN NOT ${runHasLiveJobs(input.id)}
    AND NOT ${evaluationRosterExists({ runId: input.id, source: "owned" })}
    AND NOT ${evaluationRosterExists({ runId: input.id, source: "requested" })}
    AND NOT ${unresolvedImageWorkExists(input.id)}
    AND NOT EXISTS (SELECT 1 FROM "RunFinding" historical_finding WHERE historical_finding."runId" = ${input.id} AND ${activeFindingSql("historical_finding")})
    AND NOT EXISTS (SELECT 1 FROM "PhotoGroupProposal" historical_proposal WHERE historical_proposal."runId" = ${input.id} AND historical_proposal.state = ${photoGroupProposalState.enum.proposed})
  ELSE false END`;
}

/** Settled AI history closes recovery only; it never rewrites the failed Run. */
export function settledAiRunPredicate(input: {
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
    AND NOT ${unresolvedImageWorkExists(input.id)})`;
}
