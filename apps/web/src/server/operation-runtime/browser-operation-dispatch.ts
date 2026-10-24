import { StatusCodes } from "http-status-codes";
import superjson from "superjson";
import { z } from "zod";

import { browserOperationPath } from "~/lib/browser-operation-path";
import type { ErrorDiagnostics } from "~/lib/error-diagnostics";
import { startOperationDefinitionFor } from "~/lib/start-operation-observability";
import { superJsonResultSchema } from "~/lib/superjson-wire";
import {
  API_AUTH,
  BROWSER_AUTH,
  authenticate,
  challengeError,
  isChallenge,
  type AuthPolicy,
  type Challenge,
  type Principal,
} from "~/server/http/authenticate";
import { getRequestId } from "~/server/observability/tracing";
import { startOperationDispatchInput } from "~/server/operation-runtime/start-operation-dispatch.contract";
import type { StartOperationDispatchInput } from "~/server/operation-runtime/start-operation-dispatch.contract";
import { dispatchStartOperation } from "~/server/operation-runtime/start-operation-dispatch.server";
import type { PublicStartOperationError } from "~/server/operation-runtime/start-operation.contract";
import {
  unparsedStartOperationDataSchema,
  type UnparsedStartOperationData,
} from "~/server/operation-runtime/start-operation.contract";
import { normalizeStartOperationError } from "~/server/operation-runtime/start-operation.server";
import { settleBatch } from "~/server/workflows/settle-batch";

type ValueCodec = "json" | "superjson";
type Dispatch = typeof dispatchStartOperation;
type Authenticate = (
  request: Request,
  policy: AuthPolicy,
) => Promise<Principal | Challenge>;

const cacheHeaders = { "cache-control": "no-store" };
const statusCodes = new Map(Object.entries(StatusCodes));
const statusForCode = (code: string): number => {
  const status = statusCodes.get(code);
  return typeof status === "number" && status >= 400 && status <= 599
    ? status
    : StatusCodes.INTERNAL_SERVER_ERROR;
};
const publicError = (
  code: string,
  message: string,
  requestId: string,
  operation = "dispatch",
  stage: ErrorDiagnostics["stage"] = "context",
): PublicStartOperationError => ({
  code,
  message,
  requestId,
  diagnostics: { origin: "server", operation, stage, causes: [] },
});

const codecFor = (request: Request): ValueCodec | null => {
  const codec = request.headers.get("x-cubby-value-codec");
  if (codec === null || codec === "json") return "json";
  return codec === "superjson" ? "superjson" : null;
};

const encode = (value: unknown, codec: ValueCodec): string =>
  JSON.stringify(codec === "superjson" ? superjson.serialize(value) : value) ??
  "null";

const decode = (
  value: unknown,
  codec: ValueCodec,
): UnparsedStartOperationData =>
  unparsedStartOperationDataSchema.parse(
    codec === "superjson"
      ? superjson.deserialize(superJsonResultSchema.parse(value))
      : value,
  );

const responseHeaders = (codec: ValueCodec, extra?: HeadersInit): Headers => {
  const headers = new Headers(extra);
  headers.set("cache-control", cacheHeaders["cache-control"]);
  headers.set("content-type", "application/json; charset=utf-8");
  if (codec === "superjson") headers.set("x-cubby-value-codec", codec);
  else headers.delete("x-cubby-value-codec");
  return headers;
};

const jsonResponse = (
  body: unknown,
  status: number,
  codec: ValueCodec,
  extraHeaders?: HeadersInit,
) =>
  new Response(encode(body, codec), {
    status,
    headers: responseHeaders(codec, extraHeaders),
  });

const parseEnvelope = (value: unknown) => {
  const envelope = z.record(z.string(), z.unknown()).parse(value);
  const operation = z.string().parse(envelope.operation);
  return startOperationDispatchInput.parse({
    operation,
    // Omitted input is the JSON equivalent of an operation with no input.
    input: Object.hasOwn(envelope, "input") ? envelope.input : undefined,
  });
};

const parseBody = async (request: Request, codec: ValueCodec) =>
  decode(await request.json(), codec);

const errorResponse = (
  error: PublicStartOperationError,
  codec: ValueCodec,
  extraHeaders?: HeadersInit,
  status = statusForCode(error.code),
) => jsonResponse(error, status, codec, extraHeaders);

const isBatchBody = (value: unknown): value is { batch: unknown[] } =>
  typeof value === "object" &&
  value !== null &&
  "batch" in value &&
  Array.isArray(value.batch);

export async function dispatchAs(
  authenticated: Principal | Challenge,
  input: StartOperationDispatchInput,
  request: Request,
  dispatch: Dispatch = dispatchStartOperation,
) {
  if (!isChallenge(authenticated))
    return dispatch({
      ...input,
      request: {
        principal: authenticated,
        headers: request.headers,
        signal: request.signal,
      },
    });
  return {
    ok: false as const,
    error: normalizeStartOperationError(
      challengeError(authenticated),
      "context",
      getRequestId(request.headers),
      {
        operation: input.operation,
        authenticated: false,
        headers: request.headers,
      },
    ).publicError,
  };
}

export function createBrowserOperationHandler(options?: {
  authenticate?: Authenticate;
  dispatch?: Dispatch;
}) {
  const authenticateRequest = options?.authenticate ?? authenticate;
  const dispatch = options?.dispatch ?? dispatchStartOperation;

  return async function handleBrowserOperationDispatch(
    request: Request,
  ): Promise<Response> {
    const requestId = getRequestId(request.headers) ?? crypto.randomUUID();
    let operation = "dispatch";
    let requestAuthenticated = false;
    const codec = codecFor(request);
    if (codec === null)
      return errorResponse(
        publicError(
          "UNSUPPORTED_MEDIA_TYPE",
          "Unsupported value codec",
          requestId,
        ),
        "json",
        undefined,
        StatusCodes.UNSUPPORTED_MEDIA_TYPE,
      );
    if (request.method !== "POST")
      return errorResponse(
        publicError("METHOD_NOT_ALLOWED", "POST required", requestId),
        codec,
        { allow: "POST" },
        StatusCodes.METHOD_NOT_ALLOWED,
      );

    try {
      // Authenticate exactly once, before reading the request body; the
      // cookie same-origin rule applies under either policy. The browser's
      // codec selects BROWSER_AUTH so its writes keep the `web` audit channel.
      const authenticated = await authenticateRequest(
        request,
        codec === "superjson" ? BROWSER_AUTH : API_AUTH,
      );
      const authHeaders = isChallenge(authenticated)
        ? undefined
        : authenticated.responseHeaders;
      if (isChallenge(authenticated)) {
        const error = normalizeStartOperationError(
          challengeError(authenticated),
          "context",
          requestId,
          {
            operation,
            authenticated: false,
            headers: request.headers,
          },
        ).publicError;
        return errorResponse(error, codec, undefined, authenticated.status);
      }
      requestAuthenticated = true;

      const body = await parseBody(request, codec);
      const pathname = new URL(request.url).pathname;

      if (isBatchBody(body)) {
        const batch = z
          .array(z.unknown())
          .min(1)
          .max(20)
          .parse(body.batch)
          .map(parseEnvelope);
        operation = batch.map(({ operation }) => operation).join(", ");
        if (
          batch.some(
            ({ operation }) =>
              startOperationDefinitionFor(operation)?.kind !== "query" ||
              startOperationDefinitionFor(operation)?.exposure === "internal",
          )
        )
          throw new z.ZodError([
            {
              code: "custom",
              path: ["batch"],
              message: "Only queries can be batched",
            },
          ]);
        z.literal(
          browserOperationPath(batch.map(({ operation }) => operation)),
        ).parse(pathname);
        const { readable, writable } = new TransformStream<Uint8Array>();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        void settleBatch(
          batch,
          async (input) => {
            try {
              return await dispatchAs(authenticated, input, request, dispatch);
            } catch (error) {
              if (request.signal.aborted) throw error;
              return {
                ok: false as const,
                error: normalizeStartOperationError(error, "input", requestId, {
                  operation: input.operation,
                  authenticated: requestAuthenticated,
                  headers: request.headers,
                }).publicError,
              };
            }
          },
          {
            concurrency: 4,
            onSettled: (index, result) => {
              const value =
                codec === "superjson" ? superjson.serialize(result) : result;
              void writer.write(
                encoder.encode(`${JSON.stringify({ i: index, r: value })}\n`),
              );
            },
          },
        ).then(
          () => writer.close(),
          (error: Error) => writer.abort(error),
        );
        const headers = responseHeaders(codec, authHeaders);
        headers.set("content-type", "application/x-ndjson; charset=utf-8");
        return new Response(readable, { headers });
      }

      const envelope = parseEnvelope(body);
      operation = envelope.operation;
      z.literal(browserOperationPath(envelope.operation)).parse(pathname);
      if (startOperationDefinitionFor(operation)?.exposure === "internal")
        return errorResponse(
          publicError("NOT_FOUND", "Operation not found", requestId, operation),
          codec,
          authHeaders,
          StatusCodes.NOT_FOUND,
        );
      const result = await dispatchAs(
        authenticated,
        envelope,
        request,
        dispatch,
      );
      if (!result.ok) return errorResponse(result.error, codec, authHeaders);
      return jsonResponse(result, StatusCodes.OK, codec, authHeaders);
    } catch (error) {
      if (request.signal.aborted) throw error;
      const normalized = normalizeStartOperationError(
        error,
        "input",
        requestId,
        {
          operation,
          authenticated: requestAuthenticated,
          headers: request.headers,
        },
      );
      return errorResponse(normalized.publicError, codec);
    }
  };
}

export const handleBrowserOperationDispatch = createBrowserOperationHandler();
