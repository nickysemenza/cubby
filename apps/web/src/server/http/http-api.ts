import { getAuth } from "~/lib/auth";
import {
  createRequestContext,
  requireActor,
} from "~/server/http/request-context";
import { dispatchStartOperation } from "~/server/operation-runtime/start-operation-dispatch.server";

import { createHttpApiHandler } from "./http-api-handler";

export const handleHttpOperation = createHttpApiHandler({
  auth: {
    getSession: (options) => getAuth().api.getSession(options),
    verifyApiKey: (options) => getAuth().api.verifyApiKey(options),
  },
  context: async (options) => requireActor(await createRequestContext(options)),
  dispatch: dispatchStartOperation,
});
