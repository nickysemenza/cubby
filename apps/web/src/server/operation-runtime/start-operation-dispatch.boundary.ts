import type { StartOperationDispatchInput } from "~/server/operation-runtime/start-operation-dispatch.contract";
import type {
  StartOperationResult,
  UnparsedStartOperationData,
} from "~/server/operation-runtime/start-operation.contract";

import { dispatchStartOperation as dispatch } from "./start-operation-dispatch.server";

/** The SSR transport consumes wire values; handler-loader types stay server-side. */
export function dispatchStartOperation(
  options: StartOperationDispatchInput & {
    request: { headers: Headers; signal: AbortSignal };
  },
): Promise<StartOperationResult<UnparsedStartOperationData>> {
  return dispatch(options);
}
