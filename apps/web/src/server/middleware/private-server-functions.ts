import { createMiddleware } from "@tanstack/react-start";

export function privateServerFunctionResponse(
  handlerType: string,
  response: Response,
): Response {
  if (handlerType !== "serverFn") return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Vary", "Cookie, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Authenticated server-function responses must never enter a shared cache. */
export const privateServerFunctionResponses = createMiddleware().server(
  async ({ handlerType, next }) => {
    const result = await next();
    return privateServerFunctionResponse(handlerType, result.response);
  },
);
