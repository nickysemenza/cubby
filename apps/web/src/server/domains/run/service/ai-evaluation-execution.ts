import { runEntityId } from "@cubby/schemas/identifiers";

import { findErrorCause } from "~/lib/error-diagnostics";
/**
 * The Run domain's side of the `ai.evaluation` drain: feature execution under
 * each requester Run's workflow context, and requester authority (pause,
 * status, funding resume). The drain itself lives in `ai/evaluation`.
 */
import type { AiEvaluationExecution } from "~/server/ai/evaluation/service/ai-evaluation-drain";
import { ConnectionEvidenceInvalidatedError } from "~/server/domains/connection/repo/entity-connections";
import { withWorkflowExecution } from "~/server/workflows/runs/execution";

import {
  pauseRunForAiWork,
  readRunStatus,
  resumeFundingStoppedRuns,
} from "../repo/ai-work-state";
import {
  executeAiRefreshTarget,
  prepareAiRefreshPage,
  type AiRefreshPorts,
} from "./ai-refresh";
import { executeAiWorkTarget, type AiWorkPorts } from "./ai-work";

export type AiEvaluationPorts = AiRefreshPorts & AiWorkPorts;

export const runAiEvaluationExecution = (
  ports: AiEvaluationPorts = {},
): AiEvaluationExecution => ({
  execute: (db, claimed, context) =>
    withWorkflowExecution(
      {
        runId: claimed.runId,
        attempt: context.claim.generation,
        database: db,
        job: context,
      },
      () =>
        claimed.executionKind === "ai_refresh"
          ? executeAiRefreshTarget(db, claimed, ports)
          : executeAiWorkTarget(db, claimed, ports),
    ),
  preparePage: (db, targets, context) =>
    prepareAiRefreshPage(db, targets, context, ports),
  evidenceInvalidated: (error) =>
    !!findErrorCause(
      error,
      (cause): cause is ConnectionEvidenceInvalidatedError =>
        cause instanceof ConnectionEvidenceInvalidatedError,
    ),
  pauseRun: async (db, runId, message) => {
    await pauseRunForAiWork(db, runEntityId.parse(runId), message);
  },
  runPaused: async (db, runId) =>
    (await readRunStatus(db, runEntityId.parse(runId))) === "paused",
  resumeFundingStopped: async (db, runIds) => {
    await resumeFundingStoppedRuns(
      db,
      runIds.map((id) => runEntityId.parse(id)),
    );
  },
});
