import { userId } from "@cubby/schemas/identifiers";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";

import { auth } from "~/lib/auth";
import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { startOperationDefinitionFor } from "~/lib/start-operation-observability";
import { createRequestContext, requireActor } from "~/server/request-context";
import { dispatchStartOperation } from "~/server/start-operation-dispatch.server";
import { unparsedStartOperationDataSchema } from "~/server/start-operation.contract";

const bodySchema = z.strictObject({
  input: unparsedStartOperationDataSchema.optional(),
});
const statuses = new Map(Object.entries(StatusCodes));
const errorStatus = z
  .number()
  .int()
  .min(400)
  .max(599)
  .catch(StatusCodes.INTERNAL_SERVER_ERROR);
const statusFor = (code: string) => errorStatus.parse(statuses.get(code));
const respond = (
  body: z.output<typeof unparsedStartOperationDataSchema>,
  status: number,
) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (code: keyof typeof StatusCodes, message: string) =>
  respond({ ok: false, error: { code, message } }, statusFor(code));

function isHttpOperation(
  operation: string,
): operation is StartOperationIdOfKind<"query" | "mutation"> {
  const definition = startOperationDefinitionFor(operation);
  return definition !== undefined && definition.kind !== "subscription";
}
export async function handleHttpOperation(
  request: Request,
  operation: string,
): Promise<Response> {
  if (!isHttpOperation(operation))
    return failure("NOT_FOUND", "Unknown operation");
  if (request.method !== "POST")
    return Response.json(
      { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use POST" } },
      { status: StatusCodes.METHOD_NOT_ALLOWED, headers: { Allow: "POST" } },
    );
  try {
    const key = request.headers.get("x-api-key");
    if (!key) return failure("UNAUTHORIZED", "API key required");
    const verification = await auth.api.verifyApiKey({
      body: { key, configId: "http-api" },
    });
    if (
      !verification.valid ||
      !verification.key ||
      verification.key.configId !== "http-api"
    )
      return failure("UNAUTHORIZED", "Invalid API key");
    if (!request.headers.get("content-type")?.includes("application/json"))
      return failure("BAD_REQUEST", "Expected application/json");
    let body: z.output<typeof bodySchema>;
    try {
      body = bodySchema.parse(await request.json());
    } catch {
      return failure("BAD_REQUEST", "Invalid JSON request body");
    }
    const headers = new Headers(request.headers);
    headers.set("origin", new URL(request.url).origin);
    const apiContext = requireActor(
      await createRequestContext({
        headers,
        actor: {
          userId: userId.parse(verification.key.referenceId),
          sessionId: null,
          source: "api",
        },
      }),
    );
    const result = await dispatchStartOperation({
      operation,
      input: body.input,
      request: { headers, signal: request.signal, apiContext },
    });
    return respond(
      result,
      result.ok ? StatusCodes.OK : statusFor(result.error.code),
    );
  } catch (error) {
    if (request.signal.aborted) throw error;
    console.error("HTTP API failed", operation, error);
    return failure(
      "INTERNAL_SERVER_ERROR",
      "The operation could not be completed",
    );
  }
}
