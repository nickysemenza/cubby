import type { BatchResult } from "@cubby/schemas/batch";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";

import { browserOperationPath } from "~/lib/browser-operation-path";
import type { StartOperationKind } from "~/lib/start-operation-observability";
import { createAppError } from "~/server/errors/app-error";
import {
  API_AUTH,
  type Authenticate,
  authenticate,
  BROWSER_AUTH,
  type Channel,
  challengeError,
  isChallenge,
  type Principal,
} from "~/server/http/authenticate";
import { getRequestId, withTrace } from "~/server/observability/tracing";
import {
  loadOperationHandler,
  loadWorkflowStreamHandler,
} from "~/server/operation-runtime/operation-handlers.server";
import {
  type PublicStartOperationError,
  type StartOperationResult,
  type UnparsedStartOperationData,
  unparsedStartOperationDataSchema,
} from "~/server/operation-runtime/start-operation.contract";
import {
  isOperationOfKind,
  normalizeStartOperationError,
  type OperationAccess,
  type OperationStage,
  resolveOperation,
} from "~/server/operation-runtime/start-operation.server";
import type { WorkflowStream } from "~/server/operation-runtime/workflow-stream.server";
import { settleBatch } from "~/server/workflows/settle-batch";

/**
 * The browser transport (and SSR, which renders for the browser) names its
 * surface. It selects `BROWSER_AUTH`, so writes keep the `web` audit channel,
 * and reaches internal operations and workflow streams. Apple, the CLI and
 * API keys send nothing.
 */
const SURFACE_HEADER = "x-cubby-surface";

/** What each client family may call, from the principal it authenticated as. */
const CHANNEL_ACCESS = {
  browser: {
    kinds: ["query", "mutation", "subscription"],
    exposure: "internal",
  },
  native: { kinds: ["query", "mutation"], exposure: "external" },
  cli: { kinds: ["query", "mutation"], exposure: "external" },
  mcp: { kinds: ["query", "mutation"], exposure: "internal" },
  system: { kinds: ["query", "mutation"], exposure: "internal" },
} as const satisfies Record<Channel, OperationAccess<StartOperationKind>>;

export type OperationCall = {
  operation: string;
  input: UnparsedStartOperationData;
  /** Correlation only (request id, ray); never authority. */
  headers: Headers;
  signal: AbortSignal;
  /** A read that may wait on a model runs against the model-read budget. */
  modelBacked?: boolean;
};

type DispatchResult = StartOperationResult<UnparsedStartOperationData>;
/** One settled batch item, in settle order. */
type BatchLine = { i: number; r: BatchResult<DispatchResult> };

export type DispatchedOperation =
  | { readonly result: DispatchResult }
  | { readonly stream: WorkflowStream };

export interface OperationDispatchPorts {
  authenticate: Authenticate;
  loadOperationHandler: typeof loadOperationHandler;
  loadWorkflowStreamHandler: typeof loadWorkflowStreamHandler;
}

const productionPorts: OperationDispatchPorts = {
  authenticate,
  loadOperationHandler,
  loadWorkflowStreamHandler,
};

const statusCodes = new Map(Object.entries(StatusCodes));
const statusForCode = (code: string): number => {
  const status = statusCodes.get(code);
  return typeof status === "number" && status >= 400 && status <= 599
    ? status
    : StatusCodes.INTERNAL_SERVER_ERROR;
};

const responseHeaders = (contentType: string, extra?: HeadersInit) => {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("content-type", contentType);
  return headers;
};

const JSON_TYPE = "application/json; charset=utf-8";
const NDJSON_TYPE = "application/x-ndjson; charset=utf-8";

/** Every client reads a refusal as the bare error under its HTTP status. */
const errorResponse = (
  error: PublicStartOperationError,
  extraHeaders?: HeadersInit,
  status = statusForCode(error.code),
) =>
  new Response(JSON.stringify(error), {
    status,
    headers: responseHeaders(JSON_TYPE, extraHeaders),
  });

const ndjsonResponse = <T>(
  values: ReadableStream<T>,
  extraHeaders?: HeadersInit,
) => {
  const encoder = new TextEncoder();
  return new Response(
    values.pipeThrough(
      new TransformStream<T, Uint8Array>({
        transform: (value, controller) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)),
      }),
    ),
    { headers: responseHeaders(NDJSON_TYPE, extraHeaders) },
  );
};

const envelopeSchema = z.object({
  operation: z.string(),
  // Omitted input is the JSON equivalent of an operation with no input.
  input: unparsedStartOperationDataSchema.optional(),
});

const batchBodySchema = z.object({
  batch: z.array(envelopeSchema).min(1).max(20),
});

const isBatchBody = (value: unknown): value is { batch: unknown } =>
  typeof value === "object" && value !== null && "batch" in value;

/**
 * Dispatch and the `/api/operations` endpoint over one set of ports; tests
 * bind their own authentication and handlers.
 */
export function createOperationDispatch(
  overrides: Partial<OperationDispatchPorts> = {},
) {
  const ports = { ...productionPorts, ...overrides };
  /**
   * The one entry from every adapter to an operation: resolve the id against
   * the registry under the principal's channel, load only its handler, and
   * run it under that principal. `kinds` narrows what this call accepts.
   */
  async function dispatchOperation(
    principal: Principal,
    call: OperationCall,
    kinds?: readonly StartOperationKind[],
  ): Promise<DispatchedOperation> {
    const requestId = getRequestId(call.headers);
    const access = CHANNEL_ACCESS[principal.channel];
    const allowed: readonly StartOperationKind[] = access.kinds;
    const resolved = resolveOperation(
      call.operation,
      {
        kinds: kinds ? allowed.filter((kind) => kinds.includes(kind)) : allowed,
        exposure: access.exposure,
      },
      { requestId, headers: call.headers, authenticated: true },
    );
    if (!resolved.ok) return { result: { ok: false, error: resolved.error } };
    const { definition } = resolved;
    const request = {
      principal,
      headers: call.headers,
      signal: call.signal,
      modelBacked: call.modelBacked,
    };
    try {
      if (isOperationOfKind(definition, ["subscription"])) {
        const handler = await withTrace(
          `start.dispatch.load.${definition.id}`,
          () => ports.loadWorkflowStreamHandler(definition.id),
        );
        return { stream: await handler({ data: call.input, request }) };
      }
      if (!isOperationOfKind(definition, ["query", "mutation"]))
        throw new Error(`${definition.id} has no handler kind`);
      const handler = await withTrace(
        `start.dispatch.load.${definition.id}`,
        () => ports.loadOperationHandler(definition.id),
      );
      const result = await handler({ data: call.input, request });
      return {
        result: result.ok
          ? {
              ...result,
              data: unparsedStartOperationDataSchema.parse(result.data),
            }
          : result,
      };
    } catch (error) {
      if (call.signal.aborted) throw error;
      return {
        result: {
          ok: false,
          error: normalizeStartOperationError(error, "dispatch", requestId, {
            operation: definition.id,
            authenticated: true,
            headers: call.headers,
          }).publicError,
        },
      };
    }
  }

  /**
   * `POST /api/operations/<id>`: one operation answered as its JSON envelope,
   * or a workflow stream as NDJSON envelopes. `{ batch }` reads answer NDJSON
   * `{ i, r }` lines in settle order. Refusals before any envelope are the
   * bare error under its status.
   */
  async function handleOperationRequest(request: Request): Promise<Response> {
    const requestId = getRequestId(request.headers) ?? crypto.randomUUID();
    let operation = "dispatch";
    let authenticated = false;
    const refusal = <TError>(
      error: TError,
      stage: OperationStage,
      status?: number,
      extraHeaders?: HeadersInit,
    ) =>
      errorResponse(
        normalizeStartOperationError(error, stage, requestId, {
          operation,
          authenticated,
          headers: request.headers,
        }).publicError,
        extraHeaders,
        status,
      );
    if (request.method !== "POST")
      return refusal(
        createAppError("OPERATION_METHOD_NOT_ALLOWED", "POST required"),
        "context",
        undefined,
        { allow: "POST" },
      );

    try {
      // Authenticate exactly once, before reading the request body; the
      // cookie same-origin rule applies under either policy.
      const principal = await ports.authenticate(
        request,
        request.headers.get(SURFACE_HEADER) === "browser"
          ? BROWSER_AUTH
          : API_AUTH,
      );
      if (isChallenge(principal))
        return refusal(challengeError(principal), "context", principal.status);
      authenticated = true;
      const authHeaders = principal.responseHeaders;
      const call = { headers: request.headers, signal: request.signal };
      const body: unknown = await request.json();
      const pathname = new URL(request.url).pathname;

      if (isBatchBody(body)) {
        const { batch } = batchBodySchema.parse(body);
        const operations = batch.map((item) => item.operation);
        operation = operations.join(", ");
        z.literal(browserOperationPath(operations)).parse(pathname);
        const { readable, writable } = new TransformStream<BatchLine>();
        const writer = writable.getWriter();
        void settleBatch(
          batch,
          async (item) => {
            const dispatched = await dispatchOperation(
              principal,
              { ...call, operation: item.operation, input: item.input },
              ["query"],
            );
            if ("result" in dispatched) return dispatched.result;
            throw new Error(`${item.operation} is not a query`);
          },
          {
            concurrency: 4,
            onSettled: (i, r) => void writer.write({ i, r }),
          },
        ).then(
          () => writer.close(),
          (error: Error) => writer.abort(error),
        );
        return ndjsonResponse(readable, authHeaders);
      }

      const envelope = envelopeSchema.parse(body);
      operation = envelope.operation;
      z.literal(browserOperationPath(envelope.operation)).parse(pathname);
      const dispatched = await dispatchOperation(principal, {
        ...call,
        operation: envelope.operation,
        input: envelope.input,
      });
      if ("stream" in dispatched)
        return ndjsonResponse(dispatched.stream, authHeaders);
      if (!dispatched.result.ok)
        return errorResponse(dispatched.result.error, authHeaders);
      return new Response(JSON.stringify(dispatched.result), {
        headers: responseHeaders(JSON_TYPE, authHeaders),
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      return refusal(error, "input");
    }
  }

  return { dispatchOperation, handleOperationRequest };
}

export const { dispatchOperation, handleOperationRequest } =
  createOperationDispatch();
