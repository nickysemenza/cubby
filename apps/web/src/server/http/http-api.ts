import { authenticate } from "~/server/http/authenticate";
import { dispatchStartOperation } from "~/server/operation-runtime/start-operation-dispatch.server";

import { createHttpApiHandler } from "./http-api-handler";

export const handleHttpOperation = createHttpApiHandler({
  authenticate,
  dispatch: dispatchStartOperation,
});
