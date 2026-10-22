import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import {
  type StartOperationDefinition,
  startOperationDefinitionFor,
} from "~/lib/start-operation-observability";
import { WORKFLOW_STREAM_HANDLER_LOADERS } from "~/server/generated/start-operation-handlers.gen";
import { getRequestId } from "~/server/observability/tracing";
import type { UnparsedStartOperationData } from "~/server/operation-runtime/start-operation.contract";
import { normalizeStartOperationError } from "~/server/operation-runtime/start-operation.server";
import type { WorkflowStreamHandler } from "~/server/operation-runtime/subscription-domain.server";
import {
  workflowStreamError,
  type WorkflowStream,
} from "~/server/operation-runtime/workflow-stream.server";

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
  workflowStreamError({
    code: "BAD_REQUEST",
    reason: "UNKNOWN_OPERATION",
    message,
  });

/**
 * One Start server function resolves subscriptions against the generated
 * registry and loads only the selected handler. Unary ids are refused.
 */
export async function dispatchWorkflowStream(
  operation: string,
  request: Request,
  input: UnparsedStartOperationData,
  port: WorkflowStreamLoaderPort = productionWorkflowStreamLoaderPort,
): Promise<WorkflowStream> {
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
    return await handler({ request, input });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return workflowStreamError(
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
