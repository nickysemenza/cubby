import {
  START_OPERATIONS,
  type StartOperationIdOfKind,
} from "~/lib/generated/start-operation-registry.gen";
import { registeredStartOperationKind } from "~/lib/start-operation-observability";
import {
  START_OPERATION_HANDLER_LOADERS,
  type StartOperationHandler,
  type StartOperationHandlerLoader,
} from "~/server/generated/start-operation-handlers.gen";
import type { StartOperationRequest } from "~/server/start-operation.server";
import type { StartOperationDispatchInput } from "~/server-functions/start-operation-dispatch.functions";

export type { StartOperationHandler } from "~/server/generated/start-operation-handlers.gen";

type StartOperationHandlerLoaders = Partial<
  Record<
    StartOperationIdOfKind<"query" | "mutation">,
    StartOperationHandlerLoader
  >
>;

export async function dispatchStartOperation(
  options: StartOperationDispatchInput & { request: StartOperationRequest },
  loaders: StartOperationHandlerLoaders = START_OPERATION_HANDLER_LOADERS,
) {
  if (
    options.operation in START_OPERATIONS &&
    registeredStartOperationKind(options.operation) === "subscription"
  ) {
    throw new Error(`${options.operation} is a workflow stream`);
  }
  const operation = options.operation as StartOperationIdOfKind<
    "query" | "mutation"
  >;
  const loader = loaders[operation];
  if (!loader) {
    throw new Error(
      `No browser handler is registered for ${options.operation}`,
    );
  }
  const handler: StartOperationHandler = await loader();
  return await handler({ data: options.input, request: options.request });
}

export const dispatchRegisteredStartOperation = dispatchStartOperation;
