import { aiRefreshActivation } from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import type { z } from "zod";

import {
  admitAiRefreshDeployment,
  activateAiRefreshDeployment,
  aiRefreshDeploymentInput,
} from "../ai/repo/ai-refresh";
import { getAiGatewayEgress } from "../cf-env";
import type { Database } from "../db";
import { defineJobHandler } from "../generic/jobs/service/jobs";
import { launchWorkflowRun } from "./runs/lifecycle";

const currentVersion = async () => {
  const egress = getAiGatewayEgress(CUBBY_AI_GATEWAY_ID);
  if (!egress)
    throw new Error("AI Gateway deployment authority is unavailable");
  return egress.currentDeploymentVersion();
};

/** The minute cron is the only startup publisher; fetches never activate policy. */
export const publishAiRefreshActivation = (
  db: Database,
  version: string,
  release: string,
) => admitAiRefreshDeployment(db, version, release, currentVersion);

export const aiRefreshActivationHandler = defineJobHandler(
  aiRefreshDeploymentInput,
  async (_db, _claim, input) => {
    if ((await currentVersion()) !== input.version)
      return { page: { done: true, result: { outcome: "superseded" } } };
    return {
      page: { done: true },
      publish: async (tx) => {
        const activation = await activateAiRefreshDeployment(tx, input);
        if (activation) await dispatchAiRefreshDiscovery(tx, activation);
        return { outcome: activation ? "activated" : "superseded" };
      },
    };
  },
);

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
