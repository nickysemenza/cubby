import {
  START_OPERATIONS,
  type StartOperationIdOfKind,
} from "~/lib/generated/start-operation-registry.gen";
import { registeredStartOperationKind } from "~/lib/start-operation-observability";
import {
  WORKFLOW_STREAM_HANDLER_LOADERS,
  type WorkflowStreamHandlerLoader,
} from "~/server/generated/start-operation-handlers.gen";
import type { WorkflowStreamHandler } from "~/server/subscription-domain.server";
import { workflowStreamErrorResponse } from "~/server/workflow-stream.server";

type WorkflowStreamHandlerLoaders = Partial<
  Record<StartOperationIdOfKind<"subscription">, WorkflowStreamHandlerLoader>
>;

const rejected = (message: string) =>
  workflowStreamErrorResponse({
    code: "BAD_REQUEST",
    reason: "UNKNOWN_OPERATION",
    message,
  });

/**
 * The stream half of `dispatchStartOperation`: one route for all subscriptions,
 * resolving the `$operation` path segment against the generated registry and
 * loading only that operation's handler module.
 *
 * A non-subscription id is refused here rather than falling through to the
 * unary dispatcher — the two share an id space, and a query answered over
 * NDJSON would look like a working stream that never invalidates anything.
 */
export async function dispatchWorkflowStream(
  operation: string,
  request: Request,
  loaders: WorkflowStreamHandlerLoaders = WORKFLOW_STREAM_HANDLER_LOADERS,
): Promise<Response> {
  if (
    !Object.hasOwn(START_OPERATIONS, operation) ||
    registeredStartOperationKind(
      operation as StartOperationIdOfKind<"subscription">,
    ) !== "subscription"
  ) {
    return rejected(`${operation} is not a registered workflow stream`);
  }
  const loader = loaders[operation as StartOperationIdOfKind<"subscription">];
  if (!loader) {
    return rejected(
      `No workflow stream handler is registered for ${operation}`,
    );
  }
  const handler: WorkflowStreamHandler = await loader();
  return await handler({ request });
}
