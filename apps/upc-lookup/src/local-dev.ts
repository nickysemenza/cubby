import { localWorkerHandler } from "./index";
import type { Env } from "./types";

/** Admin and MCP refreshes fetch remote images/providers; local peers expose
 * the real lookup/search/cache read boundary used by Cubby only. */
export default {
  fetch(request: Request, env: Env, context: ExecutionContext) {
    const pathname = new URL(request.url).pathname;
    const allowed =
      (request.method === "GET" &&
        (pathname.startsWith("/lookup/") ||
          pathname.startsWith("/images/") ||
          ["/search", "/stats", "/health"].includes(pathname))) ||
      (request.method === "POST" && pathname === "/lookup/batch");
    if (!allowed) {
      return Response.json(
        {
          error: "provider_unavailable",
          message: "Local UPC fixtures support cached lookup and search only.",
        },
        { status: 503 },
      );
    }
    return localWorkerHandler.fetch(request, env, context);
  },
};
