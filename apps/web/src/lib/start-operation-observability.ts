/**
 * Low-cardinality client → Worker context for TanStack Start server functions.
 *
 * Headers are untrusted input: only this closed operation/entity vocabulary is
 * admitted to traces.  Keep request input (shortcodes, search strings, and
 * form values) out of this contract.
 */
import {
  type RegisteredStartOperationKind,
  START_OPERATIONS,
  type StartOperationId,
} from "~/lib/generated/start-operation-registry.gen";

const START_OPERATION_HEADER = "x-cubby-operation";
const START_OPERATION_KIND_HEADER = "x-cubby-operation-kind";
const START_OPERATION_ENTITY_HEADER = "x-cubby-operation-entity";

export type StartOperationKind = "query" | "mutation" | "subscription";
export type { StartOperationId };

const PRODUCT_DETAIL_PHASES = [
  "resolve",
  "base",
  "pricing",
  "quantity",
  "breadcrumbs",
  "quality",
  "recipe_usages",
  "food",
] as const;
export type ProductDetailPhase = (typeof PRODUCT_DETAIL_PHASES)[number];

export type StartOperationDefinition<
  Id extends StartOperationId = StartOperationId,
> = {
  readonly id: Id;
  readonly kind: RegisteredStartOperationKind<Id>;
  readonly entities: readonly string[];
  readonly productPhases: readonly ProductDetailPhase[];
};

export type StartOperationTraceContext = {
  operation: StartOperationId;
  kind: StartOperationKind;
  entity?: string;
};

const isStartOperation = (value: string | null): value is StartOperationId =>
  value !== null && Object.hasOwn(START_OPERATIONS, value);

export const startOperationDefinitionFor = (
  operation: string,
): StartOperationDefinition | undefined =>
  isStartOperation(operation) ? startOperationDefinition(operation) : undefined;

const isStartOperationKind = (
  operation: StartOperationId,
  value: string | null,
): value is StartOperationKind =>
  value !== null && START_OPERATIONS[operation].kind === value;

export const registeredStartOperationKind = <Id extends StartOperationId>(
  operation: Id,
): RegisteredStartOperationKind<Id> => START_OPERATIONS[operation].kind;

export const isStartOperationEntity = (
  operation: StartOperationId,
  value: unknown,
): value is string =>
  typeof value === "string" &&
  (START_OPERATIONS[operation].entities as readonly string[]).includes(value);

export const startOperationDefinition = <Id extends StartOperationId>(
  operation: Id,
): StartOperationDefinition<Id> =>
  ({
    id: operation,
    ...START_OPERATIONS[operation],
  }) as StartOperationDefinition<Id>;

/**
 * Build the only semantic dimensions a browser Start call may send to tracing.
 * Unknown operations deliberately retain only the local operation id.
 */
export function startOperationHeaders(options: {
  operation: StartOperationId;
  kind: StartOperationKind;
  entity?: string;
}): Record<string, string> {
  if (!isStartOperation(options.operation)) return {};
  if (!isStartOperationKind(options.operation, options.kind)) return {};
  const headers: Record<string, string> = {
    [START_OPERATION_HEADER]: options.operation,
    [START_OPERATION_KIND_HEADER]: options.kind,
  };
  if (isStartOperationEntity(options.operation, options.entity)) {
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
    ...(isStartOperationEntity(operation, entity) ? { entity } : {}),
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
