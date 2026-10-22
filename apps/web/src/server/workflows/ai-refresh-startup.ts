import { aiRefreshActivation } from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import type { z } from "zod";

import { activateAiRefresh } from "../ai/repo/ai-refresh";
import { setCfEnv } from "../cf-env";
import type { Database } from "../db";
import { withInvocationDb } from "../db";
import { launchWorkflowRun } from "./runs/lifecycle";

/** Called only by the singleton's own version, never with a caller-supplied policy. */
export async function observeAiRefreshFeatures(
  env: Env,
  observationEpoch: number,
) {
  setCfEnv(env);
  return withInvocationDb(env.HYPERDRIVE.connectionString, async () => {
    const { db } = await import("../db");
    const activation = await activateAiRefresh(db, __GIT_COMMIT__, {
      enabled: true,
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
) {
  if (!activation.enabled || !activation.discoveryRunId) return;
  await launchWorkflowRun(db, {
    runId: runEntityId.parse(activation.discoveryRunId),
    purpose: "ai_refresh",
    automatic: true,
  });
}
