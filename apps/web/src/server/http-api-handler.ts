import { userId } from "@cubby/schemas/identifiers";
import { parseJsonQueryObject } from "@ts-rest/core";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";

import { httpContract } from "~/lib/generated/http-contract.gen";
import { type StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { httpMetadataSchema, type HttpMetadata } from "~/lib/http-api/contract";
import { httpRoutes, httpPathSchema } from "~/lib/http-api/routes";
import { startOperationDefinitionFor } from "~/lib/start-operation-observability";
import type { RequestActor, requireActor } from "~/server/request-context";
import type { dispatchStartOperation } from "~/server/start-operation-dispatch.server";
import {
  unparsedStartOperationDataSchema,
  type UnparsedStartOperationData,
} from "~/server/start-operation.contract";

const bodySchema = z.strictObject({
  input: unparsedStartOperationDataSchema.optional(),
});
const objectSchema = z.record(z.string(), unparsedStartOperationDataSchema);
const createdSchema = z.object({ item: z.object({ id: z.string() }) });
const statuses = new Map(Object.entries(StatusCodes));
const errorStatus = z
  .number()
  .int()
  .min(400)
  .max(599)
  .catch(StatusCodes.INTERNAL_SERVER_ERROR);
const respond = (
  body: UnparsedStartOperationData,
  status: number,
  headers?: Record<string, string>,
) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
const failure = (
  code: keyof typeof StatusCodes,
  message: string,
  headers?: Record<string, string>,
) =>
  respond(
    { ok: false, error: { code, message } },
    errorStatus.parse(statuses.get(code)),
    headers,
  );
const routes = httpRoutes(httpContract);
function isOrdinaryOperation(
  operation: string,
): operation is StartOperationIdOfKind<"query" | "mutation"> {
  const definition = startOperationDefinitionFor(operation);
  return definition !== undefined && definition.kind !== "subscription";
}

function readQuery(
  request: Request,
  metadata: HttpMetadata,
): UnparsedStartOperationData {
  const params = new URL(request.url).searchParams;
  if (new Set(params.keys()).size !== params.size)
    throw new Error("Duplicate query parameters");
  const query = objectSchema.parse(
    parseJsonQueryObject(Object.fromEntries(params)),
  );
  if (
    metadata.mode === "undefined" ||
    metadata.mode === "null" ||
    metadata.mode === "detail"
  ) {
    if (params.size) throw new Error("Unexpected query parameters");
    return metadata.mode === "null" ? null : undefined;
  }
  if (metadata.mode === "wrapped") return bodySchema.parse(query).input;
  if (metadata.mode === "list")
    return {
      ...query,
      filters: query.filters === undefined ? {} : query.filters,
      entity: metadata.entity,
    };
  return query;
}
async function readInput(
  request: Request,
  metadata: HttpMetadata,
  id?: string,
): Promise<UnparsedStartOperationData> {
  if (request.method === "GET") {
    const query = readQuery(request, metadata);
    return metadata.mode === "detail"
      ? { entity: metadata.entity, shortcode: id }
      : query;
  }
  if (metadata.mode === "delete")
    return { action: "delete", entity: metadata.entity, ids: [id] };
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new Error("Expected application/json");
  const body = await request.json();
  if (metadata.mode === "legacy") return bodySchema.parse(body).input;
  const input = {
    action: metadata.mode,
    entity: metadata.entity,
    data: objectSchema.parse(body),
  };
  return id ? { ...input, id } : input;
}
async function authenticate(request: Request, authApi: HttpApiPorts["auth"]) {
  if (request.headers.has("x-api-key")) {
    const key = request.headers.get("x-api-key");
    if (!key) return null;
    const verification = await authApi.verifyApiKey({
      body: { key, configId: "http-api" },
    });
    if (!verification.valid || verification.key?.configId !== "http-api")
      return null;
    return {
      userId: userId.parse(verification.key.referenceId),
      sessionId: null,
      source: "api" as const,
    };
  }
  const session = await authApi.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!session) return null;
  return {
    userId: userId.parse(session.user.id),
    sessionId: session.session.id,
    source: "api" as const,
  };
}
interface HttpApiPorts {
  auth: {
    getSession(options: {
      headers: Headers;
      query: { disableCookieCache: true };
    }): Promise<{ user: { id: string }; session: { id: string } } | null>;
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
export function createHttpApiHandler(ports: HttpApiPorts) {
  return async function handleHttpOperation(
    request: Request,
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const exact = routes.filter((route) => route.path === pathname);
    const matching = exact.length
      ? exact
      : routes.filter(
          (route) =>
            route.path.endsWith("/:id") &&
            pathname.startsWith(route.path.slice(0, -3)) &&
            !pathname.slice(route.path.length - 3).includes("/"),
        );
    if (!matching.length) return failure("NOT_FOUND", "Unknown endpoint");
    let id: string | undefined;
    const itemRoute = matching.find((candidate) =>
      candidate.path.endsWith("/:id"),
    );
    if (itemRoute) {
      try {
        id = decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
      } catch {
        return failure("NOT_FOUND", "Invalid resource identifier");
      }
      if (!httpPathSchema(itemRoute)?.safeParse({ id }).success)
        return failure("NOT_FOUND", "Invalid resource identifier");
    }
    const route = matching.find(
      (candidate) => candidate.method === request.method,
    );
    if (!route)
      return failure("METHOD_NOT_ALLOWED", "Unsupported method", {
        Allow: [...new Set(matching.map((candidate) => candidate.method))].join(
          ", ",
        ),
      });
    const metadata = z
      .object({ http: httpMetadataSchema })
      .parse(route.metadata).http;
    const operation = metadata.operation;
    if (!isOrdinaryOperation(operation))
      return failure("NOT_FOUND", "Unknown operation");
    try {
      const actor = await authenticate(request, ports.auth);
      if (!actor)
        return failure("UNAUTHORIZED", "Valid API key or session required");
      if (
        !request.headers.has("x-api-key") &&
        request.method !== "GET" &&
        request.headers.get("origin") !== new URL(request.url).origin
      )
        return failure("FORBIDDEN", "Same-origin request required");
      let input: UnparsedStartOperationData;
      try {
        input = await readInput(request, metadata, id);
      } catch {
        return failure("BAD_REQUEST", "Invalid request input");
      }
      const headers = new Headers(request.headers);
      headers.set("origin", new URL(request.url).origin);
      const apiContext = await ports.context({ headers, actor });
      const result = await ports.dispatch({
        operation,
        input,
        request: { headers, signal: request.signal, apiContext },
      });
      if (!result.ok)
        return respond(
          result,
          errorStatus.parse(statuses.get(result.error.code)),
        );
      if (metadata.mode === "detail" && result.data === null)
        return failure("NOT_FOUND", "Resource not found");
      if (metadata.mode === "create")
        return respond(result, StatusCodes.CREATED, {
          Location: `${pathname}/${encodeURIComponent(createdSchema.parse(result.data).item.id)}`,
        });
      return respond(result, StatusCodes.OK);
    } catch (error) {
      if (request.signal.aborted) throw error;
      console.error("HTTP API failed", operation, error);
      return failure(
        "INTERNAL_SERVER_ERROR",
        "The operation could not be completed",
      );
    }
  };
}
