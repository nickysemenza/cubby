import { runEntityId } from "@cubby/schemas/identifiers";

import type { AiEvaluationExecution } from "~/server/ai/evaluation/service/ai-evaluation-drain";
/**
 * The Run domain's side of the `ai.evaluation` drain: feature execution under
 * each requester Run's workflow context, and requester authority (pause,
 * status, funding resume). The drain itself lives in `ai/evaluation`.
 */
import { resumeFundingStoppedRuns } from "~/server/ai/funding-wait";
import { withWorkflowExecution } from "~/server/workflows/runs/execution";

import { pauseRunForAiWork, readRunStatus } from "../repo/ai-work-state";
import { executeAiRefreshTarget, type AiRefreshPorts } from "./ai-refresh";
import { executeAiWorkTarget, type AiWorkPorts } from "./ai-work";

export type AiEvaluationPorts = AiRefreshPorts & AiWorkPorts;

export const runAiEvaluationExecution = (
  ports: AiEvaluationPorts = {},
): AiEvaluationExecution => ({
  execute: (db, claimed, context) =>
    withWorkflowExecution(
      {
        runId: claimed.runId,
        attempt: claimed.attempts + 1,
        database: db,
        job: context,
      },
      () =>
        claimed.executionKind === "ai_refresh"
          ? executeAiRefreshTarget(db, claimed, ports)
          : executeAiWorkTarget(db, claimed, ports),
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
