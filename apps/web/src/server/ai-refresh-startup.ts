import { aiRefreshActivation } from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import type { z } from "zod";

import { setCfEnv } from "./cf-env";
import type { Database } from "./db";
import { withRequestDbClient } from "./db";
import { run } from "./db/schema";
import { activateAiRefresh } from "./repo/ai-refresh";
import { getDb } from "./repo/database-helpers";
import { workflowInstanceId } from "./workflow-runs/contract";
import {
  ENDED_INSTANCE_STATES,
  productionWorkflowLauncher,
  type WorkflowLauncher,
} from "./workflow-runs/launcher";
import {
  failWorkflowRun,
  launchWorkflowRun,
  runFailureText,
} from "./workflow-runs/lifecycle";

/** Called only by the singleton's own version, never with a caller-supplied policy. */
export async function observeAiRefreshFeatures(
  env: Env,
  observationEpoch: number,
) {
  setCfEnv(env);
  return withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
    const { db } = await import("./db");
    const activation = await activateAiRefresh(db, __GIT_COMMIT__, {
      enabled: env.AI_REFRESH_ENABLED === "true",
      startDiscovery: true,
      observationEpoch,
    });
    if (activation.observationEpoch !== observationEpoch)
      return activation.observationEpoch;
    await dispatchAiRefreshDiscovery(db, activation);
    return activation.observationEpoch;
  });
}

export async function dispatchAiRefreshDiscovery(
  db: Database,
  activation: z.infer<typeof aiRefreshActivation>,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
) {
  if (!activation.enabled || !activation.discoveryRunId) return;
  const [owner] = await getDb(db)
    .select({
      shortcode: run.shortcode,
      status: run.status,
      failureCode: run.failureCode,
      attempt: sql<number>`coalesce((${run.progress}->>'attempt')::int, 0)`,
    })
    .from(run)
    .where(eq(run.id, runEntityId.parse(activation.discoveryRunId)));
  if (
    !owner ||
    owner.failureCode === "user_cancelled" ||
    owner.status === "completed"
  )
    return;
  if (owner.status === "running" && owner.attempt > 0) {
    const status = await launcher.status(
      "ai_refresh",
      workflowInstanceId(owner.shortcode, owner.attempt),
    );
    if (!ENDED_INSTANCE_STATES.has(status.state)) {
      if (status.state === "unknown")
        throw new Error("AI refresh startup Workflow state is unknown");
      return;
    }
    if (
      !(await failWorkflowRun(
        db,
        {
          runId: runEntityId.parse(activation.discoveryRunId),
          attempt: owner.attempt,
        },
        {
          failureCode: "workflow_instance_ended",
          message: runFailureText(
            `AI refresh startup Workflow is ${status.state}${status.error ? `: ${status.error}` : ""}`,
          ),
        },
      ))
    )
      return;
  }
  await launchWorkflowRun(
    db,
    {
      runId: runEntityId.parse(activation.discoveryRunId),
      purpose: "ai_refresh",
      automatic: true,
    },
    launcher,
  );
}
