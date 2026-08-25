/**
 * Low-cardinality client → Worker context for TanStack Start server functions.
 *
 * Headers are untrusted input: only this closed operation/entity vocabulary is
 * admitted to traces.  Keep request input (shortcodes, search strings, and
 * form values) out of this contract.
 */
const START_OPERATION_HEADER = "x-cubby-operation";
const START_OPERATION_KIND_HEADER = "x-cubby-operation-kind";
const START_OPERATION_ENTITY_HEADER = "x-cubby-operation-entity";

const startOperations = {
  "background-batch.summary": ["query"],
  "cookbook.detail": ["query"],
  "cookbook.list": ["query"],
  "entity.detail": ["query"],
  "entity.filterOptions": ["query"],
  "entity.inspectorHealth": ["query"],
  "entity.list": ["query"],
  "entity.mutate": ["mutation"],
  "entityIntegrity.catalog": ["query"],
  "image.delete": ["mutation"],
  "image.detail": ["query"],
  "image.list": ["query"],
  "image.projectSummaries": ["query"],
  "image.update": ["mutation"],
  "problems.getByType": ["query"],
  "usda-food.detail": ["query"],
  "usda-food.list": ["query"],
} as const;

const startEntities = new Set([
  "ingredient",
  "product",
  "recipe",
  "cookbook",
  "location",
  "inventory",
  "ledgerParty",
  "ledgerTransfer",
  "meal",
  "project",
  "task",
  "vendor",
  "purchase",
  "expense",
  "financialAccount",
  "financialTransaction",
  "wish",
  "usda-food",
  "image",
]);

export type StartOperationKind = "query" | "mutation";

export type StartOperationTraceContext = {
  operation: keyof typeof startOperations;
  kind: StartOperationKind;
  entity?: string;
};

const isStartOperation = (
  value: string | null,
): value is keyof typeof startOperations =>
  value !== null && Object.hasOwn(startOperations, value);

const isStartOperationKind = (
  operation: keyof typeof startOperations,
  value: string | null,
): value is StartOperationKind =>
  value !== null &&
  (startOperations[operation] as readonly string[]).includes(value);

export const isStartOperationEntity = (value: unknown): value is string =>
  typeof value === "string" && startEntities.has(value);

/**
 * Build the only semantic dimensions a browser Start call may send to tracing.
 * Unknown operations deliberately retain only the local operation id.
 */
export function startOperationHeaders(options: {
  operation: string;
  kind: StartOperationKind;
  entity?: string;
}): Record<string, string> {
  if (!isStartOperation(options.operation)) return {};
  if (!isStartOperationKind(options.operation, options.kind)) return {};
  const headers: Record<string, string> = {
    [START_OPERATION_HEADER]: options.operation,
    [START_OPERATION_KIND_HEADER]: options.kind,
  };
  if (isStartOperationEntity(options.entity)) {
    headers[START_OPERATION_ENTITY_HEADER] = options.entity;
  }
  return headers;
}

/** Parse only validated low-cardinality dimensions from an inbound request. */
export function readStartOperationTraceContext(
  headers: Pick<Headers, "get">,
): StartOperationTraceContext | undefined {
  const operation = headers.get(START_OPERATION_HEADER);
  if (!isStartOperation(operation)) return undefined;
  const kind = headers.get(START_OPERATION_KIND_HEADER);
  if (!isStartOperationKind(operation, kind)) return undefined;
  const entity = headers.get(START_OPERATION_ENTITY_HEADER);
  return {
    operation,
    kind,
    ...(isStartOperationEntity(entity) ? { entity } : {}),
  };
}

export const startOperationTraceName = (
  context: StartOperationTraceContext,
): string => `start.${context.kind}.${context.operation}`;

/** Distinct outer transport layer; the authoritative operation keeps `start.*`. */
export const serverFunctionTraceName = (
  context: StartOperationTraceContext,
): string => `server_fn.${context.kind}.${context.operation}`;

export const startOperationTraceAttributes = (
  context: StartOperationTraceContext | undefined,
): Record<string, string> =>
  context
    ? {
        "rpc.system": "start",
        "rpc.method": context.operation,
        "rpc.type": context.kind,
        ...(context.entity ? { "cubby.entity": context.entity } : {}),
      }
    : {};
