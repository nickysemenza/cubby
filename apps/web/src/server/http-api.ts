import { auth } from "~/lib/auth";
import { createRequestContext, requireActor } from "~/server/request-context";
import { dispatchStartOperation } from "~/server/start-operation-dispatch.server";

import { createHttpApiHandler } from "./http-api-handler";

export const handleHttpOperation = createHttpApiHandler({
  auth: auth.api,
  context: async (options) => requireActor(await createRequestContext(options)),
  dispatch: dispatchStartOperation,
});
