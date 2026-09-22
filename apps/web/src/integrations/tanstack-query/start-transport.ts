import { z } from "zod";

import {
  isStartOperationEntity,
  registeredStartOperationKind,
  type StartOperationId,
} from "~/lib/start-operation-observability";
import type {
  PublicStartOperationError,
  StartOperationResult,
  UnparsedStartOperationData,
} from "~/server/start-operation.contract";
import {
  publicStartOperationErrorSchema,
  unparsedStartOperationDataSchema,
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
    const { message: _message, ...data } = error;
    this.data = data;
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
    const result = await options.call(new Headers(operationHeaders(observed)));
    finishObservedOperation(observed, { result });
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

/** Explicit adapter shape used by focused tests and in-process callers. */
type StartTransportInvocation<Input> = (
  input: Input,
  transport: { signal?: AbortSignal; headers: HeadersInit },
) => Promise<StartOperationResult<unknown>>;

export interface StartTransportRuntime {
  dispatch(
    operation: StartOperationId,
    input: UnparsedStartOperationData,
    transport: { signal?: AbortSignal; headers: HeadersInit },
  ): Promise<StartOperationResult<UnparsedStartOperationData>>;
}

const unparsedStartOperationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: unparsedStartOperationDataSchema }),
  z.object({ ok: z.literal(false), error: publicStartOperationErrorSchema }),
]);

async function dispatchStartOperation<Input>(
  operation: StartOperationId,
  input: Input,
  transport: { signal?: AbortSignal; headers: HeadersInit },
): Promise<StartOperationResult<UnparsedStartOperationData>> {
  const { dispatchStartOperationTransport } =
    await import("~/server-functions/start-operation-dispatch.functions");
  return unparsedStartOperationResultSchema.parse(
    await dispatchStartOperationTransport({
      data: { operation, input },
      signal: transport.signal,
      headers: transport.headers,
    }),
  );
}

let dispatchOverride: StartTransportRuntime["dispatch"] | null = null;

/**
 * Test seam: route every operation without its own transport through
 * `dispatch` until the returned restore runs. The browser test harness uses it
 * so an unmocked read fails inside the test instead of reaching the real
 * Start dispatcher and rejecting after teardown.
 */
export function overrideStartDispatch(
  dispatch: StartTransportRuntime["dispatch"],
): () => void {
  const previous = dispatchOverride;
  dispatchOverride = dispatch;
  return () => {
    dispatchOverride = previous;
  };
}

const productionStartTransportRuntime: StartTransportRuntime = {
  dispatch: (operation, input, transport) =>
    (dispatchOverride ?? dispatchStartOperation)(operation, input, transport),
};

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
 * Bind an operation name, parser, and optional adapter once. Production calls
 * lazily import the one shared Start dispatcher; importing a domain catalog
 * never initializes Start or any server module.
 */
export function startOperation<Input, Output>(
  config: {
    operation: StartOperationId;
    kind?: "query" | "mutation";
    entity?: string;
    /**
     * Override the shared dispatcher. Production operations normally omit this;
     * focused transport tests and exceptional adapters may still supply one.
     */
    transport?: StartTransportInvocation<Input>;
    parse: (data: UnparsedStartOperationData, input: Input) => Output;
    createError?: (error: PublicStartOperationError) => Error;
  },
  runtime: StartTransportRuntime = productionStartTransportRuntime,
): StartOperation<Input, Output> {
  if (
    config.entity &&
    !isStartOperationEntity(config.operation, config.entity)
  ) {
    throw new Error(
      `${config.entity} is not registered for ${config.operation}`,
    );
  }
  const build = (entity: string | undefined): StartOperation<Input, Output> => {
    const meta: CubbyOperationMeta = {
      transport: "start",
      operation: config.operation,
      observedByTransport: true,
    };
    if (entity) meta.entity = entity;
    return {
      operation: config.operation,
      meta,
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
                unparsedStartOperationResultSchema.parse(
                  await (
                    config.transport ??
                    ((value, transport) =>
                      runtime.dispatch(
                        config.operation,
                        unparsedStartOperationDataSchema.parse(value),
                        transport,
                      ))
                  )(input, {
                    signal: options?.signal,
                    headers,
                  }),
                ),
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
    };
  };
  return build(config.entity);
}
