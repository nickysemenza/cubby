import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export const authenticatedStartServerFunction = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  const request = getRequest();
  return await next({
    context: {
      startOperation: { headers: request.headers, signal: request.signal },
    },
  });
});
