import { z } from "zod";

import { scrubErrorMessage } from "../../lib/error-diagnostics";

const routeErrorBody = z.object({ error: z.string() });

/**
 * An error thrown past a server route becomes h3's generic 5xx JSON body
 * (`{ message: "HTTPError" }`), so the client can only show "(500)". Error
 * surfaces show raw diagnostics (AGENTS.md), so put the scrubbed thrown error
 * in the `error` field `throwHttpError` reads. A route's own `error` body and
 * non-JSON responses (SSR error pages) pass through untouched.
 */
export async function withUnhandledErrorBody(
  response: Response,
  error: Error,
): Promise<Response> {
  if (!response.headers.get("content-type")?.includes("application/json"))
    return response;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (routeErrorBody.safeParse(body).success) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(
    { error: scrubErrorMessage(`${error.name}: ${error.message}`) },
    { status: response.status, statusText: response.statusText, headers },
  );
}
