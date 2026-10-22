import { getDatabaseFreshnessNamespace } from "~/server/cf-env";
import { createRequestContext } from "~/server/http/request-context";

export async function handleDatabaseChangesSocket(
  request: Request,
): Promise<Response> {
  if (
    request.method !== "GET" ||
    request.headers.get("origin") !== new URL(request.url).origin
  )
    return new Response("Same-origin subscription required", { status: 403 });
  const context = await createRequestContext({ headers: request.headers });
  if (!context.auth.userId || !context.actorContext || !context.currentParty)
    return new Response("Authentication required", { status: 401 });
  const namespace = getDatabaseFreshnessNamespace();
  if (!namespace)
    return new Response("Change subscription unavailable", { status: 503 });
  return namespace
    .getByName("household", { locationHint: "wnam" })
    .fetch(request);
}
