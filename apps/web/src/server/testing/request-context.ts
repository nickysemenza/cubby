import { buildActorContext } from "@cubby/schemas/context";
import type { UserId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import { buildCrudServices, currentParty } from "~/server/request-context";
import type { UsdaReleaseRpc } from "~/server/usda-release/rpc";
import type { RequestOrigin } from "~/server/workload";

/** A loaded release holding no foods: every lookup misses, every search is empty. */
const emptyUsdaRelease: UsdaReleaseRpc = {
  status: async () => {
    throw new Error("Test USDA release has no load status");
  },
  resume: async () => {
    throw new Error("Test USDA release cannot resume");
  },
  counts: async () => ({
    release: "2000-01",
    foodsByDataType: {},
    supersededCount: 0,
  }),
  getFood: async () => null,
  lookupBatch: async (lookups) => lookups.map(() => null),
  search: async () => ({ data: [], count: 0 }),
};

/** Build a deterministic request context for workflow and service tests. */
export const createTestRequestContext = (
  db: Database,
  opts: {
    headers?: Headers;
    auth?: { userId: UserId };
  } = {},
) => {
  const crudServices = buildCrudServices(db, {
    usdaRelease: emptyUsdaRelease,
  });
  const auth = opts.auth
    ? { userId: opts.auth.userId, sessionId: "test-session-id" }
    : { userId: null, sessionId: null };
  const requestOrigin: RequestOrigin = "ui";
  return {
    ...crudServices,
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
