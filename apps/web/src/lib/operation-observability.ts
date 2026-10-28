/**
 * Low-cardinality client → Worker context for TanStack Start server functions.
 *
 * Headers are untrusted input: only this closed operation/entity vocabulary is
 * admitted to traces.  Keep request input (shortcodes, search strings, and
 * form values) out of this contract.
 */
import {
  type RegisteredOperationKind,
  OPERATIONS,
  type OperationId,
} from "~/lib/generated/operation-registry.gen";

const OPERATION_HEADER = "x-cubby-operation";
const OPERATION_KIND_HEADER = "x-cubby-operation-kind";
const OPERATION_ENTITY_HEADER = "x-cubby-operation-entity";

/** Per-operation trace headers; a batched request names its operations in its body instead. */
export const OPERATION_TRACE_HEADERS: readonly string[] = [
  OPERATION_HEADER,
  OPERATION_KIND_HEADER,
  OPERATION_ENTITY_HEADER,
];

export type OperationKind = "query" | "mutation" | "subscription";
export type { OperationId };

export type ProductDetailPhase =
  (typeof OPERATIONS)["entity.detail"]["productPhases"][number];

export type OperationDefinition<Id extends OperationId = OperationId> = {
  readonly id: Id;
  readonly kind: RegisteredOperationKind<Id>;
  readonly exposure?: "capability" | "view" | "internal";
  readonly entities: readonly string[];
  readonly productPhases: readonly ProductDetailPhase[];
};

export type OperationTraceContext = {
  operation: OperationId;
  kind: OperationKind;
  entity?: string;
};

export interface OperationHeaders extends Record<string, string> {}

export interface OperationTraceAttributes extends Record<string, string> {}

const isOperation = (value: string | null): value is OperationId =>
  value !== null && Object.hasOwn(OPERATIONS, value);

export const operationDefinitionFor = (
  operation: string,
): OperationDefinition | undefined =>
  isOperation(operation) ? operationDefinition(operation) : undefined;

const isOperationKind = (
  operation: OperationId,
  value: string | null,
): value is OperationKind =>
  value !== null && OPERATIONS[operation].kind === value;

export const registeredOperationKind = <Id extends OperationId>(
  operation: Id,
): RegisteredOperationKind<Id> => OPERATIONS[operation].kind;

export const isOperationEntity = (
  operation: OperationId,
  value: string | null | undefined,
): value is string =>
  value != null &&
  new Set<string>(operationDefinition(operation).entities).has(value);

export const operationDefinition = <Id extends OperationId>(
  operation: Id,
): OperationDefinition<Id> => {
  const registered = OPERATIONS[operation];
  return {
    id: operation,
    kind: registeredOperationKind(operation),
    ...("exposure" in registered ? { exposure: registered.exposure } : {}),
    entities: "entities" in registered ? registered.entities : [],
    productPhases:
      "productPhases" in registered ? registered.productPhases : [],
  } satisfies OperationDefinition<Id>;
};

/**
 * Build the only semantic dimensions a browser Start call may send to tracing.
 * Unknown operations deliberately retain only the local operation id.
 */
export function operationTraceHeaders(options: {
  operation: OperationId;
  kind: OperationKind;
  entity?: string;
}): OperationHeaders {
  if (!isOperation(options.operation)) return {};
  if (!isOperationKind(options.operation, options.kind)) return {};
  const headers: OperationHeaders = {
    [OPERATION_HEADER]: options.operation,
    [OPERATION_KIND_HEADER]: options.kind,
  };
  if (isOperationEntity(options.operation, options.entity)) {
    headers[OPERATION_ENTITY_HEADER] = options.entity;
  }
  return headers;
}

/** Parse only validated low-cardinality dimensions from an inbound request. */
export function readOperationTraceContext(
  headers: Pick<Headers, "get">,
): OperationTraceContext | undefined {
  const operation = headers.get(OPERATION_HEADER);
  if (!isOperation(operation)) return undefined;
  const kind = headers.get(OPERATION_KIND_HEADER);
  if (!isOperationKind(operation, kind)) return undefined;
  const entity = headers.get(OPERATION_ENTITY_HEADER);
  const context: OperationTraceContext = {
    operation,
    kind,
  };
  if (isOperationEntity(operation, entity)) context.entity = entity;
  return context;
}

export const operationTraceName = (context: OperationTraceContext): string =>
  `start.${context.kind}.${context.operation}`;

/** Distinct outer transport layer; the authoritative operation keeps `start.*`. */
export const serverFunctionTraceName = (
  context: OperationTraceContext,
): string => `server_fn.${context.kind}.${context.operation}`;

export const operationTraceAttributes = (
  context: OperationTraceContext | undefined,
): OperationTraceAttributes => {
  if (!context) return {};
  const attributes: OperationTraceAttributes = {
    "rpc.system": "start",
    "rpc.method": context.operation,
    "rpc.type": context.kind,
  };
  if (context.entity) attributes["cubby.entity"] = context.entity;
  return attributes;
};
