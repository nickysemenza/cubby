import {
  acceptMemberWriteCookie,
  beginMemberWrite,
  STRONG_READ_HEADER,
} from "~/lib/read-consistency";
import {
  parseOperationOutput,
  StartOperationError,
} from "~/lib/start-operation-error";
import {
  isStartOperationEntity,
  registeredStartOperationKind,
  type StartOperationId,
} from "~/lib/start-operation-observability";
import {
  type PublicStartOperationError,
  type StartOperationResult,
  type UnparsedStartOperationData,
  unparsedStartOperationDataSchema,
} from "~/server/operation-runtime/start-operation.contract";

import {
  dispatchBrowserOperation,
  type OperationTransportOptions,
  postOperation,
} from "./browser-operation-transport";
import type { CubbyOperationMeta } from "./operation-meta";
import {
  beginObservedOperation,
  finishObservedOperation,
  operationHeaders,
} from "./operation-recorder";

export function unwrapStartOperationResult<T>(
  operation: string,
  result: StartOperationResult<T>,
  createError: (error: PublicStartOperationError) => Error = (error) =>
    new StartOperationError(error),
): T {
  acceptMemberWriteCookie(result.readMarker);
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

type ObservedOutcome = Parameters<typeof finishObservedOperation>[1];

/**
 * Observe one call and fence this member's reads around a write: a mutation
 * or workflow stream begins a member write before it starts, and again when
 * it fails or is abandoned, so no read settles on data from before it.
 */
export function beginOperationCall(options: {
  operation: StartOperationId;
  kind: "query" | "mutation";
  entity?: string;
  speculative?: boolean;
  input: UnparsedStartOperationData;
}) {
  const writes = registeredStartOperationKind(options.operation) !== "query";
  const observed = beginObservedOperation({ ...options, transport: "start" });
  if (writes) beginMemberWrite();
  return {
    headers: new Headers(operationHeaders(observed)),
    finish(outcome: ObservedOutcome, abandoned = false) {
      if (writes && (abandoned || outcome.error !== undefined))
        beginMemberWrite();
      finishObservedOperation(observed, outcome);
    },
  };
}

async function observedStartCall<T>(options: {
  operation: StartOperationId;
  kind?: "query" | "mutation";
  entity?: string;
  speculative?: boolean;
  input: UnparsedStartOperationData;
  call: (headers: Headers) => Promise<T>;
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
  const call = beginOperationCall({ ...options, kind: registeredKind });
  try {
    const result = await options.call(call.headers);
    call.finish({ result });
    return result;
  } catch (error) {
    call.finish({ error });
    throw error;
  }
}

export type StartCallOptions = {
  /** Keep this read in its own Worker invocation while retaining shared admission. */
  batch?: boolean;
  signal?: AbortSignal;
  speculative?: boolean;
  consistency?: "strong";
};

type StartDispatch = (
  operation: StartOperationId,
  input: UnparsedStartOperationData,
  transport: OperationTransportOptions,
) => Promise<StartOperationResult<UnparsedStartOperationData>>;

/**
 * SSR answers through the same `/api/operations` handler and response
 * decoding as the browser, in process, under the page request's credential.
 */
async function dispatchServerOperation(
  operation: StartOperationId,
  input: UnparsedStartOperationData,
  transport: OperationTransportOptions,
): Promise<StartOperationResult<UnparsedStartOperationData>> {
  const [{ getRequest }, { handleBrowserOperationDispatch }] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("~/server/operation-runtime/browser-operation-dispatch"),
    ]);
  const page = getRequest();
  const headers = new Headers(page.headers);
  headers.delete("content-length");
  new Headers(transport.headers).forEach((value, name) =>
    headers.set(name, value),
  );
  // The page request already passed the same-origin read rule; the operation
  // it renders is this origin's own request.
  headers.set("origin", new URL(page.url).origin);
  return postOperation(
    { operation, input },
    headers,
    transport.signal ?? page.signal,
    (url, init) =>
      handleBrowserOperationDispatch(new Request(new URL(url, page.url), init)),
  );
}

let dispatchOverride: StartDispatch | null = null;

/**
 * Test seam: route every operation through `dispatch` until the returned
 * restore runs. The browser test harness uses it so an unmocked read fails
 * inside the test instead of reaching the real dispatcher and rejecting after
 * teardown.
 */
export function overrideStartDispatch(dispatch: StartDispatch): () => void {
  const previous = dispatchOverride;
  dispatchOverride = dispatch;
  return () => {
    dispatchOverride = previous;
  };
}

const dispatchStart: StartDispatch = (operation, input, transport) => {
  if (dispatchOverride) return dispatchOverride(operation, input, transport);
  if (!import.meta.env.SSR)
    return dispatchBrowserOperation(operation, input, transport);
  return dispatchServerOperation(operation, input, transport);
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
 * Bind an operation name and parser once. Production calls lazily import the
 * one shared dispatcher; importing a domain catalog never initializes Start
 * or any server module.
 */
export function startOperation<Input, Output>(config: {
  operation: StartOperationId;
  kind?: "query" | "mutation";
  entity?: string;
  parse: (
    data: UnparsedStartOperationData,
    input: Input,
  ) => Output | Promise<Output>;
  createError?: (error: PublicStartOperationError) => Error;
  /** `withTransport`'s bound answer, still observed and fenced like dispatch. */
  dispatch?: (
    input: Input,
    transport: { signal?: AbortSignal },
  ) => Promise<StartOperationResult<UnparsedStartOperationData>>;
}): StartOperation<Input, Output> {
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
      call: (input, options) => {
        const data = unparsedStartOperationDataSchema.parse(input);
        return observedStartCall({
          operation: config.operation,
          kind: config.kind,
          entity,
          speculative: options?.speculative,
          input: data,
          call: async (headers) => {
            if (options?.consistency === "strong")
              headers.set(STRONG_READ_HEADER, "strong");
            const result = config.dispatch
              ? await config.dispatch(input, { signal: options?.signal })
              : await dispatchStart(config.operation, data, {
                  signal: options?.signal,
                  headers,
                  ...(options?.batch === false ? { batch: false } : {}),
                });
            const value = unwrapStartOperationResult(
              config.operation,
              result,
              config.createError,
            );
            return parseOperationOutput(config.operation, () =>
              config.parse(value, input),
            );
          },
        });
      },
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
