import { z } from "zod";

import { publishBackgroundTasks } from "./background-tasks/publish";
import { getAiRefreshEnabled } from "./cf-env";
import { withRequestDbClient } from "./db";
import { isMaintenanceMode } from "./maintenance";
import { activateAiRefresh } from "./repo/ai-refresh";

const activationBody = z.object({ release: z.string().min(1) });
const activationSecrets = z.object({
  AI_REFRESH_ACTIVATION_TOKEN: z.string().min(32).optional(),
});

/** Only the deployment credential can activate the served build, with no caller-supplied manifest. */
export async function activateDeployedAiRefresh(request: Request, env: Env) {
  const token = activationSecrets.parse(env).AI_REFRESH_ACTIVATION_TOKEN;
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`)
    return new Response("AI refresh activation credential is required", {
      status: 401,
    });
  if (isMaintenanceMode(env))
    return new Response("AI refresh is paused for maintenance", {
      status: 503,
    });
  const input = activationBody.parse(await request.json());
  if (input.release !== __GIT_COMMIT__)
    return new Response(
      "AI refresh activation release does not match the served build",
      { status: 409 },
    );
  return withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
    const { db } = await import("./db");
    const activation = await activateAiRefresh(db, input.release, {
      enabled: getAiRefreshEnabled(),
    });
    if (activation.enabled)
      await publishBackgroundTasks(
        db,
        [
          {
            kind: "maintenance.recover",
            requestedAt: new Date().toISOString(),
          },
        ],
        { source: "ai-refresh.deployment" },
      );
    return Response.json({
      release: activation.release,
      enabled: activation.enabled,
    });
  });
}
