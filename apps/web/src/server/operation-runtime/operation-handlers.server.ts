import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import {
  START_OPERATION_HANDLERS,
  WORKFLOW_STREAM_HANDLERS,
} from "~/server/generated/start-operation-handler-data.gen";
import type {
  StartOperationResult,
  UnparsedStartOperationData,
} from "~/server/operation-runtime/start-operation.contract";
import type { StartOperationRequest } from "~/server/operation-runtime/start-operation.server";
import type { WorkflowStreamHandler } from "~/server/operation-runtime/subscription-domain.server";

export type UnaryOperationId = StartOperationIdOfKind<"query" | "mutation">;
export type StreamOperationId = StartOperationIdOfKind<"subscription">;
export type UnaryHandlerTable = Readonly<
  Record<UnaryOperationId, readonly [string, string]>
>;
export type StreamHandlerTable = Readonly<
  Record<StreamOperationId, readonly [string, string]>
>;
export type StartOperationHandler<Output = UnparsedStartOperationData> =
  (options: {
    data: UnparsedStartOperationData;
    request: StartOperationRequest;
  }) => Promise<StartOperationResult<Output>>;
export type OperationHandler = StartOperationHandler<unknown>;

type HandlerModule = Record<
  string,
  {
    operations?: Record<string, OperationHandler>;
    streams?: Record<string, WorkflowStreamHandler>;
  }
>;
const modules = import.meta.glob<HandlerModule>([
  "../domains/*/operations/*.ts",
  "../domains/*/operations.server.ts",
  "../generic/*/operations/*.ts",
  "../ai/chatgpt/chatgpt.server.ts",
  "../http/maintenance.server.ts",
  "../http/oauth/oauth.server.ts",
  "../mcp/mcp.server.ts",
  "../mcp/playbooks.server.ts",
  "./entity-list-runtime.server.ts",
  "./entity-runtime.server.ts",
  "!../**/*.test.ts",
]);

// Fail at module load, not on a member's first call, when a generated table
// path has no glob entry (the keys are relative to this directory).
for (const [path] of [
  ...Object.values(START_OPERATION_HANDLERS),
  ...Object.values(WORKFLOW_STREAM_HANDLERS),
])
  if (!(path in modules))
    throw new Error(`No operation module loader for ${path}`);

async function loadDomain([path, name]: readonly [string, string]) {
  const loader = modules[path];
  if (!loader) throw new Error(`No operation module loader for ${path}`);
  const domain = (await loader())[name];
  if (!domain) throw new Error(`No operation domain ${name} in ${path}`);
  return domain;
}

/** Only the selected handler module and its static dependencies initialize. */
export async function loadOperationHandler(
  operation: UnaryOperationId,
): Promise<OperationHandler> {
  const domain = await loadDomain(START_OPERATION_HANDLERS[operation]);
  const handler =
    domain.operations?.[operation.slice(operation.lastIndexOf(".") + 1)];
  if (!handler) throw new Error(`No operation handler for ${operation}`);
  return handler;
}

export async function loadWorkflowStreamHandler(
  operation: StreamOperationId,
): Promise<WorkflowStreamHandler> {
  const domain = await loadDomain(WORKFLOW_STREAM_HANDLERS[operation]);
  const handler =
    domain.streams?.[operation.slice(operation.lastIndexOf(".") + 1)];
  if (!handler) throw new Error(`No workflow stream handler for ${operation}`);
  return handler;
}
