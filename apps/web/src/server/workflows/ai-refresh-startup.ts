import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";

import {
  admitAiRefreshDeployment,
  activateAiRefreshDeployment,
  aiRefreshDeploymentInput,
} from "../ai/repo/ai-refresh";
import { getAiGatewayEgress } from "../cf-env";
import type { Database } from "../db";
import { repositoryAfterCommit } from "../db/repository-access.boundary";
import { defineJobHandler } from "../generic/jobs/service/jobs";

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
        if (activation) await dispatchAiRefreshDiscovery(tx);
        return { outcome: activation ? "activated" : "superseded" };
      },
    };
  },
);

/** The discovery drain (`ai-refresh.discovery`) reads the new activation on its next round. */
async function dispatchAiRefreshDiscovery(db: Database) {
  await repositoryAfterCommit(db, async () =>
    (await import("./background-tasks/publish")).wakeJobs({
      source: "ai-refresh-activation",
    }),
  );
}
