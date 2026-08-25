import type { PublicImpactItem } from "@cubby/schemas/entity-integrity";
import {
  beginObservedOperation,
  finishObservedOperation,
  operationHeaders,
} from "~/integrations/tanstack-query/operation-recorder";

export type PublicEntityError = {
  message: string;
  code?: string;
  reason?: string;
  blockers?: PublicImpactItem[];
};

export type EntityTransportOperation =
  | "entity.list"
  | "entity.detail"
  | "entity.filterOptions"
  | "entity.mutate"
  | "entity.inspectorHealth";

export type EntityTransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PublicEntityError };

export class EntityTransportError extends Error {
  readonly data: Omit<PublicEntityError, "message">;

  constructor(error: PublicEntityError) {
    super(error.message);
    this.name = "EntityTransportError";
    this.data = {
      ...(error.code ? { code: error.code } : {}),
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.blockers ? { blockers: error.blockers } : {}),
    };
  }
}

export function unwrapEntityTransportResult<T>(
  operation: EntityTransportOperation,
  result: EntityTransportResult<T>,
  createError: (error: PublicEntityError) => Error = (error) =>
    new EntityTransportError(error),
): T {
  if (!result.ok) throw createError(result.error);
  if (result.data === undefined) {
    throw createError({
      code: "INTERNAL_SERVER_ERROR",
      reason: "INVALID_TRANSPORT_RESULT",
      message: `${operation} returned an empty success envelope`,
    });
  }
  return result.data;
}

export async function observedEntityCall<T>(options: {
  operation: EntityTransportOperation;
  kind?: "query" | "mutation";
  entity?: string;
  speculative?: boolean;
  input: unknown;
  call: (headers: HeadersInit) => Promise<T>;
}): Promise<T> {
  const observed = beginObservedOperation({
    kind: options.kind ?? "query",
    transport: "start",
    operation: options.operation,
    entity: options.entity,
    speculative: options.speculative,
    input: options.input,
  });
  try {
    const result = await options.call(operationHeaders(observed));
    finishObservedOperation(observed, { result });
    return result;
  } catch (error) {
    finishObservedOperation(observed, { error });
    throw error;
  }
}
