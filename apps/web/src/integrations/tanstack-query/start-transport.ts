import { markFreshReads } from "~/lib/fresh-read-marker";
import {
  isStartOperationEntity,
  registeredStartOperationKind,
  type StartOperationId,
} from "~/lib/start-operation-observability";
import type {
  PublicStartOperationError,
  StartOperationResult,
} from "~/server/start-operation.contract";
import type { CubbyOperationMeta } from "./operation-meta";
import {
  beginObservedOperation,
  finishObservedOperation,
  operationHeaders,
} from "./operation-recorder";

export class StartOperationError extends Error {
  readonly data: Omit<PublicStartOperationError, "message">;
  readonly requestId: string | undefined;

  constructor(error: PublicStartOperationError) {
    super(error.message);
    this.name = "StartOperationError";
    this.requestId = error.requestId;
    this.data = {
      code: error.code,
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
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

async function observedStartCall<T>(options: {
  operation: StartOperationId;
  kind?: "query" | "mutation";
  entity?: string;
  speculative?: boolean;
  input: unknown;
  call: (headers: HeadersInit) => Promise<T>;
}): Promise<T> {
  const registeredKind = registeredStartOperationKind(options.operation);
  if (registeredKind === "subscription") {
    throw new Error(
      `${options.operation} is a workflow stream, not a Start transport operation`,
    );
  }
  if (options.kind && options.kind !== registeredKind) {
    throw new Error(
      `${options.operation} is registered as ${registeredKind}, not ${options.kind}`,
    );
  }
  const observed = beginObservedOperation({
    kind: registeredKind,
    transport: "start",
    operation: options.operation,
    entity: options.entity,
    speculative: options.speculative,
    input: options.input,
  });
  try {
    const result = await options.call(operationHeaders(observed));
    finishObservedOperation(observed, { result });
    if (registeredKind === "mutation") markFreshReads();
    return result;
  } catch (error) {
    finishObservedOperation(observed, { error });
    throw error;
  }
}

export type StartCallOptions = {
  signal?: AbortSignal;
  speculative?: boolean;
};

/** What a bound Start server function needs from its caller, and nothing more. */
type StartTransportInvocation<Input> = (
  input: Input,
  transport: { signal?: AbortSignal; headers: HeadersInit },
) => Promise<StartOperationResult<unknown>>;

export interface StartOperation<Input, Output> {
  readonly operation: StartOperationId;
  /**
   * Query/mutation metadata derived from the same declaration the call uses, so
   * `meta.operation`/`meta.entity` cannot drift from what the recorder observes.
   */
  readonly meta: CubbyOperationMeta;
  call(input: Input, options?: StartCallOptions): Promise<Output>;
  /** Label a generic entity operation with the entity it was invoked for. */
  forEntity(entity: string): StartOperation<Input, Output>;
}

/**
 * Bind one Start server function to its operation name, output parser, and
 * error type once, and hand back everything a caller needs: the observed call
 * and the Query metadata that describes it.
 *
 * The `transport` function must be declared at module top level with
 * `createServerFn(...)` — the TanStack Start compiler only transforms
 * statically recognizable declarations, so a server function created inside
 * this helper would never be extracted from the client bundle. Callers pass the
 * already-declared server function in; this module only wraps the call.
 */
export function startOperation<Input, Output>(config: {
  operation: StartOperationId;
  kind?: "query" | "mutation";
  entity?: string;
  transport: StartTransportInvocation<Input>;
  parse: (data: unknown, input: Input) => Output;
  createError?: (error: PublicStartOperationError) => Error;
}): StartOperation<Input, Output> {
  if (
    config.entity &&
    !isStartOperationEntity(config.operation, config.entity)
  ) {
    throw new Error(
      `${config.entity} is not registered for ${config.operation}`,
    );
  }
  const build = (
    entity: string | undefined,
  ): StartOperation<Input, Output> => ({
    operation: config.operation,
    meta: {
      transport: "start",
      operation: config.operation,
      ...(entity ? { entity } : {}),
      observedByTransport: true,
    },
    call: (input, options) =>
      observedStartCall({
        operation: config.operation,
        kind: config.kind,
        entity,
        speculative: options?.speculative,
        input,
        call: async (headers) =>
          config.parse(
            unwrapStartOperationResult(
              config.operation,
              await config.transport(input, {
                signal: options?.signal,
                headers,
              }),
              config.createError,
            ),
            input,
          ),
      }),
    forEntity: (next) => {
      if (!isStartOperationEntity(config.operation, next)) {
        throw new Error(`${next} is not registered for ${config.operation}`);
      }
      return build(next);
    },
  });
  return build(config.entity);
}
