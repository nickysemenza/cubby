import { buildActorContext } from "@cubby/schemas/context";
import type { UserId } from "@cubby/schemas/identifiers";
import type { JSONType } from "zod";

import type { Database } from "~/server/db";
import { buildCrudServices, currentParty } from "~/server/request-context";
import type { RequestOrigin } from "~/server/workload";

const jsonResponse = (status: number, body: JSONType) =>
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
  const usdaFetcher: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    return url.includes("/search/batch")
      ? jsonResponse(200, { results: [] })
      : jsonResponse(404, null);
  };
  const crudServices = buildCrudServices(db, {
    usdaFetcher,
  });
  const auth = opts.auth
    ? { userId: opts.auth.userId, sessionId: "test-session-id" }
    : { userId: null, sessionId: null };
  const requestOrigin: RequestOrigin = "ui";
  return {
    ...crudServices,
    readDb: opts.readDb ?? db,
    readConsistency: {
      consistency: "strong" as const,
      reason: "single-database" as const,
    },
    auth,
    currentParty: auth.userId
      ? async () => await currentParty(db, auth.userId!)
      : null,
    isSystemRequest: false,
    actorContext: auth.userId ? buildActorContext(auth.userId, "web") : null,
    requestOrigin,
    headers: opts.headers ?? new Headers(),
  };
};
