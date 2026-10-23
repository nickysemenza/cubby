import { isAppRoute, type AppRoute, type AppRouter } from "@ts-rest/core";
import {
  createFetchHandler,
  type RouterImplementation,
  TsRestHttpError,
  type TsRestRequest,
  TsRestResponse,
} from "@ts-rest/serverless/fetch";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";

import { httpContract } from "~/lib/generated/http-contract.gen";
import { type StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { type HttpMetadata, httpMetadataSchema } from "~/lib/http-api/router";
import { httpRoutes } from "~/lib/http-api/routes";
import { startOperationDefinitionFor } from "~/lib/start-operation-observability";
import { withErrorReporting } from "~/server/errors/report-error";
import {
  API_AUTH,
  type Authenticate,
  isChallenge,
  type Principal,
} from "~/server/http/authenticate";
import { getRequestId } from "~/server/observability/tracing";
import type { dispatchStartOperation } from "~/server/operation-runtime/start-operation-dispatch.server";
import {
  type PublicStartOperationError,
  type UnparsedStartOperationData,
  unparsedStartOperationDataSchema,
} from "~/server/operation-runtime/start-operation.contract";
import {
  normalizeStartOperationError,
  type OperationStage,
} from "~/server/operation-runtime/start-operation.server";

interface HttpApiPorts {
  authenticate: Authenticate;
  dispatch: typeof dispatchStartOperation;
}

type ApiRequest = TsRestRequest & { principal?: Principal };

const statuses = new Map(Object.entries(StatusCodes));
const validationPart = z
  .object({
    issues: z.array(
      z.object({
        message: z.string(),
        path: z
          .array(
            z.union([z.string(), z.number(), z.object({ key: z.unknown() })]),
          )
          .optional(),
      }),
    ),
  })
  .nullable();
const errorStatus = z
  .number()
  .int()
  .min(400)
  .max(599)
  .catch(StatusCodes.INTERNAL_SERVER_ERROR);
/** An error response body: the public operation error, nothing around it. */
const errorBody = (
  code: keyof typeof StatusCodes,
  message: string,
  extra: Partial<PublicStartOperationError> = {},
) => ({ code, message, ...extra });
const failure = (
  code: keyof typeof StatusCodes,
  message: string,
  extra?: Partial<PublicStartOperationError>,
) =>
  new TsRestHttpError(
    errorStatus.parse(statuses.get(code)),
    errorBody(code, message, extra),
  );
/** Tells a route's own error body from the adapter's bare 404. */
const apiErrorBody = z.object({ code: z.string(), message: z.string() });
/**
 * The adapter's request-validation error, read structurally: the fetch entry
 * exports only the deprecated Zod-typed class while the router throws the
 * standard-schema one, and both carry the same four part errors.
 */
const validationFailure = z.object({
  pathParamsError: validationPart,
  headersError: validationPart,
  queryError: validationPart,
  bodyError: validationPart,
});
const wrappedSchema = z.object({
  input: unparsedStartOperationDataSchema.optional(),
});

function isOrdinaryOperation(
  operation: string,
): operation is StartOperationIdOfKind<"query" | "mutation"> {
  const definition = startOperationDefinitionFor(operation);
  return definition !== undefined && definition.kind !== "subscription";
}

/** Reshape a validated request into the Start operation's input. */
function requestInput(
  metadata: HttpMetadata,
  route: AppRoute,
  request: { body?: unknown; query?: unknown; params?: unknown },
): UnparsedStartOperationData {
  // ts-rest validated the parts against the wire schemas; the parse here only
  // narrows them to the dispatcher's JSON contract.
  const payload = unparsedStartOperationDataSchema.parse(
    route.method === "GET" ? request.query : request.body,
  );
  if (metadata.input === "none") return undefined;
  if (metadata.input === "null") return null;
  if (metadata.input === "wrapped") return wrappedSchema.parse(payload).input;
  return payload;
}

const bracketedKey = /^(?<name>[^[\]]+)\[\d*\]$/u;

/**
 * Lists travel as repeated keys (`?tag=a&tag=b`), which is what the routes
 * validate. A qs-style client such as ts-rest's own sends `tag[]=a` or
 * `tag[0]=a&tag[1]=b` instead; both fold onto the repeated-key form here so
 * either spelling reaches the same list.
 */
const normalizeQueryLists = (request: TsRestRequest): void => {
  const folded: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(routerQuery.parse(request.query))) {
    const name = bracketedKey.exec(key)?.groups?.name ?? key;
    const existing = folded[name];
    folded[name] =
      existing === undefined && name === key
        ? value
        : [
            ...(existing === undefined ? [] : [existing].flat()),
            ...[value].flat(),
          ];
  }
  request.query = folded;
};

const routerQuery = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string())]),
);

const routeKey = (route: AppRoute) => route.path.replace(/:[^/]+/gu, ":id");
const routePattern = (key: string) =>
  new RegExp(
    `^${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/:id/gu, "[^/]+")}$`,
    "u",
  );

/** Method-not-allowed needs the route table; the adapter only knows 404. */
function methodTable(router: AppRouter) {
  const byPath = new Map<string, { pattern: RegExp; methods: Set<string> }>();
  for (const route of httpRoutes(router)) {
    const key = routeKey(route);
    const entry = byPath.get(key) ?? {
      pattern: routePattern(key),
      methods: new Set<string>(),
    };
    entry.methods.add(route.method);
    byPath.set(key, entry);
  }
  return [...byPath.values()];
}

/**
 * ts-rest's `TsRestRequest` subclasses the global `Request`, whose constructor
 * reads undici's private state from its input. The Vite dev server passes
 * srvx's `NodeRequest`, which is `instanceof Request` without that state, so
 * every write failed locally with "Cannot read private member #state". Copying
 * into a native `Request` costs one body buffer; uploads go straight to R2.
 */
async function nativeRequest(request: Request): Promise<Request> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    signal: request.signal,
  });
}

export function createHttpApiHandler(ports: HttpApiPorts) {
  const methods = methodTable(httpContract);
  const diagnosticContexts = new WeakMap<
    Request,
    { authenticated: boolean; operation: string; stage: OperationStage }
  >();

  const authenticate = async (request: ApiRequest) => {
    const diagnostics = diagnosticContexts.get(request);
    const authenticated = await ports.authenticate(request, API_AUTH, {
      onVerified: () => {
        if (diagnostics) diagnostics.authenticated = true;
      },
    });
    if (isChallenge(authenticated))
      throw failure(authenticated.code, authenticated.message);
    request.principal = authenticated;
  };

  const implement = (route: AppRoute) => {
    const metadata = httpMetadataSchema.parse(route.metadata);
    return {
      middleware: [
        async (request: ApiRequest) => {
          diagnosticContexts.set(request, {
            authenticated: false,
            operation: metadata.operation,
            stage: "context",
          });
          await authenticate(request);
        },
      ],
      handler: async (
        args: { body?: unknown; query?: unknown; params?: unknown },
        context: { request: ApiRequest; responseHeaders: Headers },
      ) => {
        const operation = metadata.operation;
        if (!isOrdinaryOperation(operation))
          throw failure("NOT_FOUND", "Unknown operation");
        const { request, responseHeaders } = context;
        const { principal } = request;
        if (!principal) throw failure("UNAUTHORIZED", "Authentication missing");
        for (const [name, value] of principal.responseHeaders)
          responseHeaders.append(name, value);
        const url = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.set("origin", url.origin);
        const diagnostic = diagnosticContexts.get(request);
        if (diagnostic) diagnostic.stage = "input";
        const input = requestInput(metadata, route, args);
        if (diagnostic) diagnostic.stage = "dispatch";
        const result = await ports.dispatch({
          operation,
          input,
          request: { principal, headers, signal: request.signal },
        });
        if (!result.ok)
          return {
            status: errorStatus.parse(statuses.get(result.error.code)),
            body: result.error,
          };
        if (diagnostic) diagnostic.stage = "output";
        if (metadata.nullableOutput === true && result.data === null)
          return {
            status: StatusCodes.NOT_FOUND,
            body: errorBody("NOT_FOUND", "Resource not found"),
          };
        return { status: StatusCodes.OK, body: result.data };
      },
    };
  };

  type Implemented = {
    [key: string]: Implemented | ReturnType<typeof implement>;
  };
  const implementRouter = (router: AppRouter): Implemented =>
    Object.fromEntries(
      Object.entries(router).map(([key, route]) => [
        key,
        isAppRoute(route) ? implement(route) : implementRouter(route),
      ]),
    );
  // Every route of the contract is implemented by the same metadata-driven
  // handler; the wire schemas and the HTTP integration tests enforce the
  // per-route responses that ts-rest would otherwise infer from literal
  // handler tables.
  const implementAll = <T extends AppRouter>(
    contract: T,
  ): RouterImplementation<T, Record<string, never>, ApiRequest> =>
    // SAFETY: `implementRouter` mirrors the contract's own key structure and
    // attaches the generic handler at every leaf, which is the shape the
    // mapped type spells for `T`.
    implementRouter(contract) as RouterImplementation<
      T,
      Record<string, never>,
      ApiRequest
    >;
  const router = implementAll(httpContract);

  const errorHandler = (error: unknown, request: TsRestRequest) => {
    if (request.signal.aborted) throw error;
    const validation =
      error instanceof TsRestHttpError &&
      error.statusCode === StatusCodes.BAD_REQUEST
        ? validationFailure.safeParse(error)
        : undefined;
    if (validation?.success) {
      const issues = Object.values(validation.data).flatMap(
        (part) =>
          part?.issues.map((issue) => ({
            code: "invalid_input",
            path: (issue.path ?? []).map((segment) =>
              z.union([z.string(), z.number()]).safeParse(segment).success
                ? String(segment)
                : String(z.object({ key: z.unknown() }).parse(segment).key),
            ),
            message: issue.message,
          })) ?? [],
      );
      return TsRestResponse.fromJson(
        errorBody("BAD_REQUEST", "Invalid request input", {
          reason: "INVALID_INPUT",
          validationIssues: issues,
        }),
        { status: StatusCodes.BAD_REQUEST },
      );
    }
    if (error instanceof TsRestHttpError) {
      const body =
        error.statusCode === StatusCodes.NOT_FOUND &&
        !apiErrorBody.safeParse(error.body).success
          ? errorBody("NOT_FOUND", "Unknown endpoint")
          : error.body;
      return TsRestResponse.fromJson(body, { status: error.statusCode });
    }
    if (error instanceof SyntaxError)
      return TsRestResponse.fromJson(
        errorBody("BAD_REQUEST", "Invalid request input"),
        { status: StatusCodes.BAD_REQUEST },
      );
    // Malformed percent-encoding in a path segment (`/recipes/%ZZ`).
    if (error instanceof URIError)
      return TsRestResponse.fromJson(
        errorBody("NOT_FOUND", "Invalid resource identifier"),
        { status: StatusCodes.NOT_FOUND },
      );
    const diagnostic = diagnosticContexts.get(request);
    const normalized = normalizeStartOperationError(
      error,
      diagnostic?.stage ?? "context",
      getRequestId(request.headers),
      {
        operation: diagnostic?.operation ?? "http-api",
        authenticated: diagnostic?.authenticated ?? false,
        headers: request.headers,
      },
    );
    return TsRestResponse.fromJson(normalized.publicError, {
      status: errorStatus.parse(statuses.get(normalized.publicError.code)),
    });
  };

  const fetchHandler = createFetchHandler(httpContract, router, {
    responseValidation: false,
    requestMiddleware: [normalizeQueryLists],
    errorHandler,
    responseHandlers: [
      (response) => {
        response.headers.set("Cache-Control", "no-store");
      },
    ],
  });

  return async function handleHttpOperation(
    incoming: Request,
  ): Promise<Response> {
    const pathname = new URL(incoming.url).pathname;
    const request = await nativeRequest(incoming);
    const matching = methods.filter((entry) => entry.pattern.test(pathname));
    if (
      matching.length &&
      !matching.some((entry) => entry.methods.has(request.method))
    )
      return Response.json(
        errorBody("METHOD_NOT_ALLOWED", "Unsupported method"),
        {
          status: StatusCodes.METHOD_NOT_ALLOWED,
          headers: {
            "Cache-Control": "no-store",
            Allow: [
              ...new Set(matching.flatMap((entry) => [...entry.methods])),
            ].join(", "),
          },
        },
      );
    return withErrorReporting(() => fetchHandler(request), request.headers);
  };
}
