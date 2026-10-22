import type {
  StartOperationResult,
  UnparsedStartOperationData,
} from "~/server/operation-runtime/start-operation.contract";

import { dispatchWorkflowStream as dispatch } from "./workflow-stream-dispatch.server";

/** Expose only wire values to the client declaration program. */
export function dispatchWorkflowStream(
  operation: string,
  request: Request,
  input: UnparsedStartOperationData,
): Promise<ReadableStream<StartOperationResult<UnparsedStartOperationData>>> {
  return dispatch(operation, request, input);
}
