import { type StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import type { StartOperationDispatchInput } from "~/server-functions/start-operation-dispatch.functions";
import {
  START_OPERATION_HANDLER_LOADERS,
  type LoadedStartOperationHandler,
  type StartOperationDispatchResult,
} from "~/server/generated/start-operation-handlers.gen";
import type { StartOperationRequest } from "~/server/start-operation.server";

type BrowserStartOperationId = StartOperationIdOfKind<"query" | "mutation">;
type StartOperationHandlerLoaders = Partial<{
  [Operation in BrowserStartOperationId]: () => Promise<
    LoadedStartOperationHandler<Operation>
  >;
}>;

export async function dispatchStartOperation(
  options: StartOperationDispatchInput & { request: StartOperationRequest },
  loaders: StartOperationHandlerLoaders = START_OPERATION_HANDLER_LOADERS,
): Promise<StartOperationDispatchResult<BrowserStartOperationId>> {
  const loader = loaders[options.operation];
  if (!loader) {
    throw new Error(
      `No browser handler is registered for ${options.operation}`,
    );
  }
  const handler = await loader();
  return await handler({ data: options.input, request: options.request });
}
