import { aiSmokeRunInput } from "@cubby/schemas/ai-smoke";
import { createServerFn } from "@tanstack/react-start";

import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const smokeContext = async (headers: Headers) => {
  const { createRequestContext, requireActor } =
    await import("~/server/request-context");
  return requireActor(await createRequestContext({ headers }));
};

export const getAiSmokeCatalog = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(async ({ context }) => {
    await smokeContext(context.startOperation.headers);
    const { smokeCatalog } = await import("~/server/ai/smoke-catalog");
    return smokeCatalog();
  });

export const runAiSmokeCase = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(aiSmokeRunInput)
  .handler(async ({ data, context }) => {
    const actor = await smokeContext(context.startOperation.headers);
    const { runAiSmoke } = await import("~/server/ai/smoke-run");
    return runAiSmoke(actor, data.scenario, data.input);
  });
