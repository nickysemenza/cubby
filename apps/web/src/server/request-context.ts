import { type AuditSource, buildActorContext } from "@cubby/schemas/context";
import { type UserId, unsafeUserId } from "@cubby/schemas/identifiers";
import { env } from "~/env";
import { auth as betterAuth } from "~/lib/auth";
import { getBindingFetcher } from "~/server/cf-env";
import { NotionClient } from "~/server/clients/notion";
import { createUpcLookupClient } from "~/server/clients/upc-lookup";
import { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { boundedStaleDb, db } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  decideReadConsistency,
  isBrowserUiRequest,
  type ReadConsistencyDecision,
} from "~/server/read-consistency";
import {
  findProductsByFoodIdentifier,
  getFoodLookupsForLinkedProducts,
} from "~/server/repo/product";
import { AvailabilityService } from "~/server/services/availability.service";
import { LocationValuationService } from "~/server/services/location-valuation.service";
import { RecipeCostingService } from "~/server/services/recipe-costing.service";
import { USDAService } from "~/server/services/usda.service";
import { extractTraceContext } from "~/server/tracing";
import type { RequestOrigin } from "~/server/workload";

export const buildCrudServices = (
  database: Database,
  opts?: { usdaFetcher?: typeof fetch },
) => {
  const notionClient = env.NOTION_API_KEY
    ? new NotionClient(env.NOTION_API_KEY)
    : null;
  const usdaClient = new USDAClient(
    env.USDA_API_URL,
    opts?.usdaFetcher ?? getBindingFetcher("USDA_API"),
  );
  const upcLookupClient = createUpcLookupClient();
  const usdaService = new USDAService(
    usdaClient,
    async (lookup) => await findProductsByFoodIdentifier(database, lookup),
    async () => await getFoodLookupsForLinkedProducts(database),
  );
  const services = {
    availability: new AvailabilityService(database, usdaClient),
    recipeCosting: new RecipeCostingService(database, usdaClient),
    locationValuation: new LocationValuationService(database),
  };

  return {
    db: database,
    notionClient,
    usdaClient,
    upcLookupClient,
    usdaService,
    services,
  };
};

export type RequestActor = {
  userId: UserId;
  sessionId: string | null;
  source: AuditSource;
};

const selectReadDatabase = (opts: {
  headers: Pick<Headers, "get">;
  actor?: RequestActor;
}): { readDb: Database; readConsistency: ReadConsistencyDecision } => {
  const readConsistency = decideReadConsistency({
    browserRequest: !opts.actor && isBrowserUiRequest(opts.headers),
    boundedStaleAvailable: boundedStaleDb !== db,
    headers: opts.headers,
  });
  return {
    readDb:
      readConsistency.consistency === "bounded-stale" ? boundedStaleDb : db,
    readConsistency,
  };
};

export const createRequestContext = async (opts: {
  headers: Headers;
  actor?: RequestActor;
}) => {
  const headersObj: Record<string, string> = {};
  opts.headers.forEach((value, key) => {
    headersObj[key] = value;
  });

  return await extractTraceContext(headersObj, async () => {
    const crudServices = buildCrudServices(db);
    const readSelection = selectReadDatabase(opts);

    if (opts.actor) {
      const { userId, sessionId, source } = opts.actor;
      const requestOrigin: RequestOrigin = source === "mcp" ? "mcp" : "api";
      return {
        ...crudServices,
        ...readSelection,
        auth: { userId, sessionId },
        actorContext: buildActorContext(userId, source),
        requestOrigin,
        ...opts,
      };
    }

    const betterSession = await betterAuth.api.getSession({
      headers: opts.headers,
    });
    const userId = betterSession?.user?.id
      ? unsafeUserId(betterSession.user.id)
      : null;

    return {
      ...crudServices,
      ...readSelection,
      auth: {
        userId,
        sessionId: betterSession?.session?.id ?? null,
      },
      actorContext: userId ? buildActorContext(userId, "ui") : null,
      requestOrigin: "ui" as RequestOrigin,
      ...opts,
    };
  });
};

type RequestContext = Awaited<ReturnType<typeof createRequestContext>>;

export function requireActor(context: RequestContext) {
  if (!context.auth.userId || !context.actorContext) {
    throw createAppError("UNAUTHORIZED", "Actor context required");
  }
  return {
    ...context,
    auth: context.auth as {
      userId: UserId;
      sessionId: string | null;
    },
    actorContext: context.actorContext,
  };
}
