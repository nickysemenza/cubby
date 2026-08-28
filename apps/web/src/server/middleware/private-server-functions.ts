import { createMiddleware } from "@tanstack/react-start";

import { withRequestId } from "~/lib/http-cache";
import { getRequestId } from "~/server/tracing";

export function privateServerFunctionResponse(
  handlerType: string,
  response: Response,
  requestId?: string,
): Response {
  if (handlerType !== "serverFn") return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Vary", "Cookie, Authorization");
  return withRequestId(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    requestId,
  );
}

/** Authenticated server-function responses must never enter a shared cache. */
export const privateServerFunctionResponses = createMiddleware().server(
  async ({ handlerType, next, request }) => {
    const result = await next();
    return privateServerFunctionResponse(
      handlerType,
      result.response,
      getRequestId(request.headers),
    );
  },
);
