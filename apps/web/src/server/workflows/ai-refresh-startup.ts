import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";

import { admitAiRefreshDeployment } from "../ai/repo/ai-refresh";
import { getAiGatewayEgress } from "../cf-env";
import type { Database } from "../db";

const currentVersion = async () => {
  const egress = getAiGatewayEgress(CUBBY_AI_GATEWAY_ID);
  if (!egress)
    throw new Error("AI Gateway deployment authority is unavailable");
  return egress.currentDeploymentVersion();
};

/**
 * The cron is the only startup publisher; fetches never activate policy. The drain that
 * follows it in the same tick reads the new activation.
 */
export const publishAiRefreshActivation = (
  db: Database,
  version: string,
  release: string,
) => admitAiRefreshDeployment(db, version, release, currentVersion);
