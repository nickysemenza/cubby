import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import {
  type StartOperationDefinition,
  startOperationDefinitionFor,
} from "~/lib/start-operation-observability";
import { WORKFLOW_STREAM_HANDLER_LOADERS } from "~/server/generated/start-operation-handlers.gen";
import { normalizeStartOperationError } from "~/server/start-operation.server";
import type { WorkflowStreamHandler } from "~/server/subscription-domain.server";
import { getRequestId } from "~/server/tracing";
import { workflowStreamErrorResponse } from "~/server/workflow-stream.server";

export interface WorkflowStreamLoaderPort {
  load: (
    operation: StartOperationIdOfKind<"subscription">,
  ) => Promise<WorkflowStreamHandler> | undefined;
}

const productionWorkflowStreamLoaderPort: WorkflowStreamLoaderPort = {
  load: (operation) => WORKFLOW_STREAM_HANDLER_LOADERS[operation]?.(),
};

type WorkflowStreamDefinition = StartOperationDefinition<
  StartOperationIdOfKind<"subscription">
>;

const isWorkflowStreamDefinition = (
  definition: StartOperationDefinition | undefined,
): definition is WorkflowStreamDefinition =>
  definition !== undefined && definition.kind === "subscription";

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
  port: WorkflowStreamLoaderPort = productionWorkflowStreamLoaderPort,
): Promise<Response> {
  const definition = startOperationDefinitionFor(operation);
  if (!isWorkflowStreamDefinition(definition)) {
    return rejected(`${operation} is not a registered workflow stream`);
  }
  try {
    const handler = await port.load(definition.id);
    if (!handler) {
      return rejected(
        `No workflow stream handler is registered for ${operation}`,
      );
    }
    return await handler({ request });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return workflowStreamErrorResponse(
      normalizeStartOperationError(
        error,
        "dispatch",
        getRequestId(request.headers),
        {
          operation: definition.id,
          authenticated: false,
          headers: request.headers,
        },
      ).publicError,
    );
  }
}
