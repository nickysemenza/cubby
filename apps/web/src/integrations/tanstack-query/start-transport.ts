import type { PublicImpactItem } from "@cubby/schemas/entity-integrity";
import {
  beginObservedOperation,
  finishObservedOperation,
  operationHeaders,
} from "./operation-recorder";

export type PublicStartValidationIssue = {
  code: string;
  path: Array<string | number>;
  message: string;
};

export type PublicStartOperationError = {
  message: string;
  code: string;
  reason?: string;
  blockers?: PublicImpactItem[];
  validationIssues?: PublicStartValidationIssue[];
};

export type StartOperationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PublicStartOperationError };

export class StartOperationError extends Error {
  readonly data: Omit<PublicStartOperationError, "message">;

  constructor(error: PublicStartOperationError) {
    super(error.message);
    this.name = "StartOperationError";
    this.data = {
      code: error.code,
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.blockers ? { blockers: error.blockers } : {}),
      ...(error.validationIssues
        ? { validationIssues: error.validationIssues }
        : {}),
    };
  }
}

export function unwrapStartOperationResult<T>(
  operation: string,
  result: StartOperationResult<T>,
  createError: (error: PublicStartOperationError) => Error = (error) =>
    new StartOperationError(error),
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

export async function observedStartCall<T>(options: {
  operation: string;
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
