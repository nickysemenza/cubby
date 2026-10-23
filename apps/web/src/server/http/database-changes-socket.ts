import { getDatabaseFreshnessNamespace } from "~/server/cf-env";
import {
  authenticate,
  BROWSER_AUTH,
  isChallenge,
} from "~/server/http/authenticate";

export async function handleDatabaseChangesSocket(
  request: Request,
): Promise<Response> {
  if (request.method !== "GET")
    return new Response("Subscription requires GET", { status: 405 });
  const authenticated = await authenticate(request, BROWSER_AUTH);
  if (isChallenge(authenticated))
    return new Response(authenticated.message, {
      status: authenticated.status,
    });
  const namespace = getDatabaseFreshnessNamespace();
  if (!namespace)
    return new Response("Change subscription unavailable", { status: 503 });
  return namespace
    .getByName("household", { locationHint: "wnam" })
    .fetch(request);
}
