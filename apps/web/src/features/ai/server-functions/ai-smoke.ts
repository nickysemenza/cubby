import {
  aiSmokeRunInput,
  type aiSmokeCatalogOut,
  type aiSmokeRunOut,
} from "@cubby/schemas/ai-smoke";
import {
  createServerFn,
  type OptionalFetcher,
  type RequiredFetcher,
} from "@tanstack/react-start";
import type { z } from "zod";

import { authenticatedStartServerFunction } from "~/server/operation-runtime/middleware/entity-server-functions";

const smokeContext = async (headers: Headers) => {
  const { createRequestContext, requireActor } =
    await import("~/server/http/request-context");
  return requireActor(await createRequestContext({ headers }));
};

export const getAiSmokeCatalog: OptionalFetcher<
  readonly [typeof authenticatedStartServerFunction],
  undefined,
  Promise<z.output<typeof aiSmokeCatalogOut>>
> = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(async ({ context }) => {
    await smokeContext(context.startOperation.headers);
    const { smokeCatalog } = await import("~/server/ai/smoke-catalog");
    return smokeCatalog();
  });

export const runAiSmokeCase: RequiredFetcher<
  readonly [typeof authenticatedStartServerFunction],
  typeof aiSmokeRunInput,
  Promise<z.output<typeof aiSmokeRunOut>>
> = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(aiSmokeRunInput)
  .handler(async ({ data, context }) => {
    const actor = await smokeContext(context.startOperation.headers);
    const { runAiSmoke } = await import("~/server/workflows/ai-smoke-run");
    return runAiSmoke(actor, data.scenario, data.input);
  });
