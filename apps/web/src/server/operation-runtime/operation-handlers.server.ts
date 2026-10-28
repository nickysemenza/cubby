import type { OperationIdOfKind } from "~/lib/generated/operation-registry.gen";
import {
  OPERATION_HANDLERS,
  WORKFLOW_STREAM_HANDLERS,
} from "~/server/generated/operation-handler-data.gen";
import type {
  OperationResult,
  OperationWireValue,
} from "~/server/operation-runtime/operation.contract";
import type { OperationRequest } from "~/server/operation-runtime/operation.server";
import type { WorkflowStreamHandler } from "~/server/operation-runtime/subscription-domain.server";

export type UnaryOperationId = OperationIdOfKind<"query" | "mutation">;
export type StreamOperationId = OperationIdOfKind<"subscription">;
export type UnaryHandlerTable = Readonly<
  Record<UnaryOperationId, readonly [string, string]>
>;
export type StreamHandlerTable = Readonly<
  Record<StreamOperationId, readonly [string, string]>
>;
export type OperationHandler<Output = OperationWireValue> = (options: {
  data: OperationWireValue;
  request: OperationRequest;
}) => Promise<OperationResult<Output>>;
type AnyOperationHandler = OperationHandler<unknown>;

type HandlerModule = Record<
  string,
  {
    operations?: Record<string, AnyOperationHandler>;
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
  ...Object.values(OPERATION_HANDLERS),
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
): Promise<AnyOperationHandler> {
  const domain = await loadDomain(OPERATION_HANDLERS[operation]);
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
