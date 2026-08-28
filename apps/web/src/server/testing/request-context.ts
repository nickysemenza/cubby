import { buildActorContext } from "@cubby/schemas/context";
import type { UserId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import { buildCrudServices } from "~/server/request-context";
import type { RequestOrigin } from "~/server/workload";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Build a deterministic request context for workflow and service tests. */
export const createTestRequestContext = (
  db: Database,
  opts: {
    headers?: Headers;
    auth?: { userId: UserId };
    readDb?: Database;
  } = {},
) => {
  const crudServices = buildCrudServices(db, {
    usdaFetcher: (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("/search/batch")
        ? jsonResponse(200, { results: [] })
        : jsonResponse(404, null);
    }) as typeof fetch,
  });
  const auth = opts.auth
    ? { userId: opts.auth.userId, sessionId: "test-session-id" }
    : { userId: null, sessionId: null };
  return {
    ...crudServices,
    readDb: opts.readDb ?? db,
    readConsistency: {
      consistency: "strong" as const,
      reason: "single-database" as const,
    },
    auth,
    isSystemRequest: false,
    actorContext: auth.userId ? buildActorContext(auth.userId, "ui") : null,
    requestOrigin: "ui" as RequestOrigin,
    headers: opts.headers ?? new Headers(),
  };
};
