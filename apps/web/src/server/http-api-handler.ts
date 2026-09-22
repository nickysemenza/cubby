import { userId } from "@cubby/schemas/identifiers";
import { isAppRoute, type AppRoute, type AppRouter } from "@ts-rest/core";
import {
  fetchRequestHandler,
  type RouterImplementation,
  TsRestHttpError,
  type TsRestRequest,
  TsRestResponse,
} from "@ts-rest/serverless/fetch";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";

import { httpContract } from "~/lib/generated/http-contract.gen";
import { type StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import {
  resourceListInputFrom,
  resourceQueryNesting,
  resourceQueryValues,
  resourceTimelineInputFrom,
} from "~/lib/http-api/resource-query";
import { type HttpMetadata, httpMetadataSchema } from "~/lib/http-api/router";
import { httpRoutes } from "~/lib/http-api/routes";
import { startOperationDefinitionFor } from "~/lib/start-operation-observability";
import { withErrorReporting } from "~/server/errors/report-error";
import {
  authenticateHttpSession,
  type HttpSessionReader,
} from "~/server/http-session-cache";
import type { RequestActor, requireActor } from "~/server/request-context";
import type { dispatchStartOperation } from "~/server/start-operation-dispatch.server";
import {
  type PublicStartOperationError,
  type UnparsedStartOperationData,
  unparsedStartOperationDataSchema,
} from "~/server/start-operation.contract";
import {
  normalizeStartOperationError,
  type OperationStage,
} from "~/server/start-operation.server";
import { getRequestId } from "~/server/tracing";

interface HttpApiPorts {
  auth: {
    getSession: HttpSessionReader;
    verifyApiKey(options: {
      body: { key: string; configId: "http-api" };
    }): Promise<{
      valid: boolean;
      key?: { configId?: string | null; referenceId: string } | null;
    }>;
  };
  context: (options: {
    headers: Headers;
    actor: RequestActor;
  }) => Promise<ReturnType<typeof requireActor>>;
  dispatch: typeof dispatchStartOperation;
}

type ApiRequest = TsRestRequest & {
  apiContext?: ReturnType<typeof requireActor>;
  sessionDataCookies?: string[];
  sessionAuthToken?: string;
};

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
const createdSchema = z.object({ item: z.object({ id: z.string() }) });
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
const idParams = z.object({ id: z.string() });

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
  if (metadata.resource !== undefined) {
    const entity = z.string().parse(metadata.entity);
    const id = () => idParams.parse(request.params ?? {}).id;
    switch (metadata.resource) {
      case "list":
        return {
          ...resourceListInputFrom(
            resourceQueryValues.parse(payload),
            route.query instanceof z.ZodType
              ? resourceQueryNesting(route.query)
              : new Map(),
          ),
          entity,
        };
      case "timeline": {
        return {
          entity,
          ...resourceTimelineInputFrom(
            resourceQueryValues.parse(payload),
            route.query instanceof z.ZodType
              ? resourceQueryNesting(route.query)
              : new Map(),
          ),
        };
      }
      case "get":
        return { entity, shortcode: id() };
      case "create":
        return { action: "create", entity, data: payload };
      case "update":
        return { action: "update", entity, id: id(), data: payload };
      case "delete":
        return { action: "delete", entity, ids: [id()] };
    }
  }
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

/** Method-not-allowed needs the route table; the adapter only knows 404. */
function methodTable(router: AppRouter) {
  const byPath = new Map<string, { pattern: RegExp; methods: Set<string> }>();
  for (const route of httpRoutes(router)) {
    const key = route.path.replace(/:[^/]+/gu, ":id");
    const entry = byPath.get(key) ?? {
      pattern: new RegExp(
        `^${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/:id/gu, "[^/]+")}$`,
        "u",
      ),
      methods: new Set<string>(),
    };
    entry.methods.add(route.method);
    byPath.set(key, entry);
  }
  return [...byPath.values()];
}

/**
 * Explicit credentials (an API key or a bearer token) are attached by the
 * caller per request; only ambient cookies can be sent cross-site by a browser,
 * so the same-origin gate applies to cookie sessions alone.
 */
const hasExplicitCredential = (request: Request) =>
  request.headers.has("x-api-key") ||
  /^bearer\s+\S/iu.test(request.headers.get("authorization") ?? "");

const sessionDataCookieName =
  /^(?:__Secure-)?better-auth\.session_data(?:\.\d+)?$/u;

const sessionDataCookiesFrom = (headers: Headers): string[] =>
  headers.getSetCookie().filter((cookie) => {
    const separator = cookie.indexOf("=");
    return (
      separator > 0 &&
      sessionDataCookieName.test(cookie.slice(0, separator).trim())
    );
  });

export function createHttpApiHandler(ports: HttpApiPorts) {
  const methods = methodTable(httpContract);
  const diagnosticContexts = new WeakMap<
    Request,
    { authenticated: boolean; operation: string; stage: OperationStage }
  >();

  const authenticate = async (request: ApiRequest) => {
    const url = new URL(request.url);
    let actor: RequestActor | null = null;
    if (request.headers.has("x-api-key")) {
      const key = request.headers.get("x-api-key");
      const verification = key
        ? await ports.auth.verifyApiKey({ body: { key, configId: "http-api" } })
        : null;
      if (verification?.valid && verification.key?.configId === "http-api")
        actor = {
          userId: userId.parse(verification.key.referenceId),
          sessionId: null,
          channel: "api",
        };
    } else {
      const sessionResult = await authenticateHttpSession({
        headers: request.headers,
        getSession: ports.auth.getSession,
      });
      const session = sessionResult.response;
      if (session && request.headers.has("authorization")) {
        request.sessionAuthToken =
          sessionResult.headers.get("set-auth-token") ?? undefined;
      }
      request.sessionDataCookies = sessionDataCookiesFrom(
        sessionResult.headers,
      );
      if (session)
        actor = {
          userId: userId.parse(session.user.id),
          sessionId: session.session.id,
          channel: "api",
        };
    }
    if (!actor)
      throw failure(
        "UNAUTHORIZED",
        "Valid API key, bearer token, or session required",
      );
    if (
      !hasExplicitCredential(request) &&
      request.method !== "GET" &&
      request.headers.get("origin") !== url.origin
    )
      throw failure("FORBIDDEN", "Same-origin request required");
    const diagnostics = diagnosticContexts.get(request);
    if (diagnostics) diagnostics.authenticated = true;
    const headers = new Headers(request.headers);
    headers.set("origin", url.origin);
    request.apiContext = await ports.context({
      headers,
      actor,
    });
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
        if (request.sessionAuthToken)
          responseHeaders.set("set-auth-token", request.sessionAuthToken);
        for (const cookie of request.sessionDataCookies ?? [])
          responseHeaders.append("Set-Cookie", cookie);
        const apiContext = request.apiContext;
        if (!apiContext)
          throw failure("UNAUTHORIZED", "Authentication missing");
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
          request: {
            headers,
            signal: request.signal,
            apiContext,
          },
        });
        if (!result.ok)
          return {
            status: errorStatus.parse(statuses.get(result.error.code)),
            body: result.error,
          };
        if (diagnostic) diagnostic.stage = "output";
        if (
          (metadata.resource === "get" || metadata.nullableOutput === true) &&
          result.data === null
        )
          return {
            status: StatusCodes.NOT_FOUND,
            body: errorBody("NOT_FOUND", "Resource not found"),
          };
        if (metadata.resource === "create") {
          responseHeaders.set(
            "Location",
            `${url.pathname}/${encodeURIComponent(createdSchema.parse(result.data).item.id)}`,
          );
          return { status: StatusCodes.CREATED, body: result.data };
        }
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

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the adapter's errorHandler contract hands over whatever a route threw
  const errorHandler = (error: unknown, request: TsRestRequest) => {
    if (request.signal.aborted) throw error;
    const validation =
      error instanceof TsRestHttpError &&
      error.statusCode === StatusCodes.BAD_REQUEST
        ? validationFailure.safeParse(error)
        : undefined;
    if (validation?.success) {
      // A malformed resource identifier is "not found", as before the adapter.
      const { pathParamsError, ...rest } = validation.data;
      if (pathParamsError && Object.values(rest).every((part) => part === null))
        return TsRestResponse.fromJson(
          errorBody("NOT_FOUND", "Invalid resource identifier"),
          { status: StatusCodes.NOT_FOUND },
        );
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

  return async function handleHttpOperation(
    request: Request,
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
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
    return withErrorReporting(
      () =>
        fetchRequestHandler({
          request,
          contract: httpContract,
          router,
          options: {
            responseValidation: false,
            requestMiddleware: [normalizeQueryLists],
            errorHandler,
            responseHandlers: [
              (response) => {
                response.headers.set("Cache-Control", "no-store");
              },
            ],
          },
        }),
      request.headers,
    );
  };
}
