import { authenticate, BROWSER_AUTH } from "~/server/http/authenticate";
import type { StartOperationDispatchInput } from "~/server/operation-runtime/start-operation-dispatch.contract";
import type {
  StartOperationResult,
  UnparsedStartOperationData,
} from "~/server/operation-runtime/start-operation.contract";

import { dispatchAs } from "./browser-operation-dispatch";

/**
 * The SSR transport consumes wire values; handler-loader types stay
 * server-side. `request` is the page request (its credential, origin and
 * signal) under which the operation renders.
 */
export async function dispatchStartOperation(
  options: StartOperationDispatchInput & { request: Request },
): Promise<StartOperationResult<UnparsedStartOperationData>> {
  const authenticated = await authenticate(options.request, BROWSER_AUTH);
  return dispatchAs(
    authenticated,
    { operation: options.operation, input: options.input },
    options.request,
  );
}
