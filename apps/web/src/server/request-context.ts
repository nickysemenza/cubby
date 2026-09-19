import { type AuditSource, buildActorContext } from "@cubby/schemas/context";
import {
  type LedgerPartyId,
  type LedgerPartyShortcode,
  type UserId,
  parseShortcodeFor,
  userId,
} from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import { env } from "~/env";
import { auth as betterAuth } from "~/lib/auth";
import { getBindingFetcher } from "~/server/cf-env";
import { NotionClient } from "~/server/clients/notion";
import { createUpcLookupClient } from "~/server/clients/upc-lookup";
import { USDAClient } from "~/server/clients/usda";
import { readDatabaseFreshness } from "~/server/database-freshness/client";
import type { Database } from "~/server/db";
import { boundedStaleDb, db } from "~/server/db";
import { ledgerParty } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  decideReadConsistency,
  type ReadConsistencyDecision,
} from "~/server/read-consistency";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  findProductsByFoodIdentifier,
  getFoodLookupsForLinkedProducts,
} from "~/server/repo/product";
import {
  countProductsByFoodIdentifiers,
  findProductsByFoodIdentifiers,
} from "~/server/repo/product/lookup";
import { AvailabilityService } from "~/server/services/availability.service";
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
    async (lookups) => await findProductsByFoodIdentifiers(database, lookups),
    async (lookups) => await countProductsByFoodIdentifiers(database, lookups),
  );
  const services = {
    availability: new AvailabilityService(database, usdaClient),
    recipeCosting: new RecipeCostingService(database, usdaClient),
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

export type CurrentParty = {
  id: LedgerPartyId;
  shortcode: LedgerPartyShortcode;
  name: string;
};

/** Resolve the authenticated member's claimed ledger party at use time. */
export const currentParty = async (
  database: Database,
  authenticatedUserId: UserId,
): Promise<CurrentParty | null> => {
  const [party] = await getDb(database)
    .select({
      id: ledgerParty.id,
      shortcode: ledgerParty.shortcode,
      name: ledgerParty.name,
    })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.userId, authenticatedUserId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
  return party
    ? {
        id: party.id,
        shortcode: parseShortcodeFor("ledgerParty", party.shortcode),
        name: party.name,
      }
    : null;
};

interface ReadDatabaseSelection {
  readDb: Database;
  readConsistency: ReadConsistencyDecision;
}

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
    const readSelection: ReadDatabaseSelection = {
      readDb: db,
      readConsistency: {
        consistency: "strong",
        reason: "authoritative-operation",
      } satisfies ReadConsistencyDecision,
    };

    if (opts.actor) {
      const { userId, sessionId, source } = opts.actor;
      const requestOrigin: RequestOrigin = source === "mcp" ? "mcp" : "api";
      return {
        ...crudServices,
        ...readSelection,
        auth: { userId, sessionId },
        currentParty: async () => await currentParty(crudServices.db, userId),
        actorContext: buildActorContext(userId, source),
        requestOrigin,
        ...opts,
      };
    }

    const betterSession = await betterAuth.api.getSession({
      headers: opts.headers,
    });
    const authenticatedUserId = betterSession?.user?.id
      ? userId.parse(betterSession.user.id)
      : null;

    const requestOrigin: RequestOrigin = "ui";
    return {
      ...crudServices,
      ...readSelection,
      auth: {
        userId: authenticatedUserId,
        sessionId: betterSession?.session?.id ?? null,
      },
      currentParty: authenticatedUserId
        ? async () => await currentParty(crudServices.db, authenticatedUserId)
        : null,
      actorContext: authenticatedUserId
        ? buildActorContext(authenticatedUserId, "ui")
        : null,
      requestOrigin,
      ...opts,
    };
  });
};

type RequestContext = Awaited<ReturnType<typeof createRequestContext>>;

export function requireActor(context: RequestContext) {
  if (!context.auth.userId || !context.actorContext || !context.currentParty) {
    throw createAppError("UNAUTHORIZED", "Actor context required");
  }
  const { userId: actorUserId } = context.auth;
  return {
    ...context,
    auth: { ...context.auth, userId: actorUserId },
    actorContext: context.actorContext,
    currentParty: context.currentParty,
  };
}

export interface DatabaseReadRouting {
  cachedDb: Database;
  readFreshness: typeof readDatabaseFreshness;
}

const productionReadRouting: DatabaseReadRouting = {
  cachedDb: boundedStaleDb,
  readFreshness: readDatabaseFreshness,
};

/** Resolve once per logical operation; later operations consult shared state again. */
export async function selectOperationContext<
  Context extends ReturnType<typeof requireActor>,
>(
  context: Context,
  policy: "context" | "strong",
  routing: DatabaseReadRouting = productionReadRouting,
): Promise<Context> {
  const readConsistency: ReadConsistencyDecision =
    policy === "strong"
      ? { consistency: "strong", reason: "authoritative-operation" }
      : decideReadConsistency({
          boundedStaleAvailable: routing.cachedDb !== context.db,
          freshness: await routing.readFreshness(),
        });
  const selected =
    readConsistency.consistency === "bounded-stale"
      ? routing.cachedDb
      : context.db;
  return {
    ...context,
    db: selected,
    readDb: selected,
    readConsistency,
    services: {
      ...context.services,
      availability: new AvailabilityService(selected, context.usdaClient),
    },
  };
}

export type AuthenticatedRequestContext = ReturnType<typeof requireActor>;
