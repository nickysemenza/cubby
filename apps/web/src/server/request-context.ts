import { type AuditChannel, buildActorContext } from "@cubby/schemas/context";
import {
  type DeviceId,
  type RunId,
  type UserId,
  userId,
} from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import { env } from "~/env";
import { auth as betterAuth } from "~/lib/auth";
import { getBindingFetcher } from "~/server/cf-env";
import type { NotionClient } from "~/server/clients/notion";
import type { USDAClient } from "~/server/clients/usda";
import { readDatabaseFreshness } from "~/server/database-freshness/client";
import type { Database } from "~/server/db";
import { boundedStaleDb, db } from "~/server/db";
import { device } from "~/server/db/schema";
import { deferredService } from "~/server/deferred-service";
import { createAppError } from "~/server/errors/app-error";
import {
  decideReadConsistency,
  type ReadConsistencyDecision,
} from "~/server/read-consistency";
import { currentMemberLedgerParty } from "~/server/repo/current-member-party";
import { getDb } from "~/server/repo/database-helpers/core";
import { notDeleted } from "~/server/repo/database-helpers/query";
import type { AvailabilityService } from "~/server/services/availability.service";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import { createUpcLookupService } from "~/server/services/upc";
import type { USDAService } from "~/server/services/usda.service";
import { annotateActiveSpan } from "~/server/tracing";
import type { RequestOrigin } from "~/server/workload";

const deferredRecipeCosting = (
  load: () => Promise<RecipeCostingService>,
  database: Database,
): RecipeCostingService =>
  deferredService(load, (loaded) => ({
    database,
    bindTo: (selected, publish) =>
      deferredRecipeCosting(
        async () => (await loaded()).bindTo(selected, publish),
        selected,
      ),
  }));

const deferredRequestServices = (
  database: Database,
  usdaClient: USDAClient,
) => {
  let pending:
    | Promise<import("./request-services").RequestServices>
    | undefined;
  const loaded = () =>
    (pending ??= import("./request-services").then((module) =>
      module.buildRequestServices(database, usdaClient),
    ));
  return {
    usdaService: deferredService<USDAService>(
      async () => (await loaded()).usdaService,
      () => ({}),
    ),
    services: {
      availability: deferredService<AvailabilityService>(
        async () => (await loaded()).services.availability,
        () => ({}),
      ),
      recipeCosting: deferredRecipeCosting(
        async () => (await loaded()).services.recipeCosting,
        database,
      ),
    },
  };
};

export const buildCrudServices = (
  database: Database,
  opts?: { usdaFetcher?: typeof fetch },
) => {
  // Built on first use: each client's SDK would otherwise load into every
  // request, and most requests never call Notion or USDA.
  const notionApiKey = env.NOTION_API_KEY;
  const notionClient = notionApiKey
    ? deferredService<NotionClient>(
        async () =>
          new (await import("~/server/clients/notion")).NotionClient(
            notionApiKey,
          ),
        () => ({}),
      )
    : null;
  const usdaFetcher = opts?.usdaFetcher ?? getBindingFetcher("USDA_API");
  const usdaClient = deferredService<USDAClient>(
    async () =>
      new (await import("~/server/clients/usda")).USDAClient(
        env.USDA_API_URL,
        usdaFetcher,
      ),
    () => ({}),
  );
  const upcLookupClient = createUpcLookupService(database);

  return {
    db: database,
    notionClient,
    usdaClient,
    upcLookupClient,
    ...deferredRequestServices(database, usdaClient),
  };
};

export type RequestActor = {
  userId: UserId;
  sessionId: string | null;
  channel: AuditChannel;
  /** The MCP OAuth client (JWT `azp`). */
  oauthClientId?: string | null;
  /** A run the credential is scoped to, e.g. the agent's delegation token. */
  runId?: RunId | null;
};

// Positive hits only: a device registered after a miss must resolve next time.
const deviceIdByInstallation = new Map<string, DeviceId>();

/** The Apple install behind `X-Cubby-Device`; null for unknown or absent. */
async function resolveRequestDevice(
  database: Database,
  headers: Headers,
): Promise<DeviceId | null> {
  const installationId = headers.get("x-cubby-device")?.trim().toLowerCase();
  if (!installationId) return null;
  const cached = deviceIdByInstallation.get(installationId);
  if (cached) return cached;
  const [row] = await getDb(database)
    .select({ id: device.id })
    .from(device)
    .where(and(eq(device.installationId, installationId), notDeleted(device)))
    .limit(1);
  if (row) deviceIdByInstallation.set(installationId, row.id);
  return row?.id ?? null;
}

export type { CurrentParty } from "~/server/repo/current-member-party";

/** Resolve the authenticated member's claimed ledger party at use time. */
export const currentParty = (database: Database, authenticatedUserId: UserId) =>
  currentMemberLedgerParty(database, { userId: authenticatedUserId });

export const createRequestContext = async (opts: {
  headers: Headers;
  actor?: RequestActor;
}) => {
  const crudServices = buildCrudServices(db);
  const readConsistency: ReadConsistencyDecision = {
    consistency: "strong",
    reason: "authoritative-operation",
  };

  const deviceId = await resolveRequestDevice(crudServices.db, opts.headers);
  if (opts.actor) {
    const { userId, sessionId, channel, oauthClientId, runId } = opts.actor;
    const requestOrigin: RequestOrigin = channel === "mcp" ? "mcp" : "api";
    annotateActiveSpan({
      "user.id": userId,
      "session.id": sessionId ?? undefined,
      "cubby.auth.channel": channel,
      "cubby.auth.oauth_client_id": oauthClientId ?? undefined,
      "cubby.run.id": runId ?? undefined,
      "cubby.device.id": deviceId ?? undefined,
    });
    return {
      ...crudServices,
      readConsistency,
      auth: { userId, sessionId },
      currentParty: async () => await currentParty(crudServices.db, userId),
      actorContext: buildActorContext(userId, channel, {
        oauthClientId,
        deviceId,
        runId,
      }),
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
  annotateActiveSpan({
    "user.id": authenticatedUserId ?? undefined,
    "session.id": betterSession?.session?.id,
    "cubby.auth.channel": authenticatedUserId ? "web" : undefined,
    "cubby.device.id": deviceId ?? undefined,
  });
  return {
    ...crudServices,
    readConsistency,
    auth: {
      userId: authenticatedUserId,
      sessionId: betterSession?.session?.id ?? null,
    },
    currentParty: authenticatedUserId
      ? async () => await currentParty(crudServices.db, authenticatedUserId)
      : null,
    actorContext: authenticatedUserId
      ? buildActorContext(authenticatedUserId, "web", { deviceId })
      : null,
    requestOrigin,
    ...opts,
  };
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
    readConsistency,
    services: {
      ...context.services,
      availability: deferredRequestServices(selected, context.usdaClient)
        .services.availability,
    },
  };
}

export type AuthenticatedRequestContext = ReturnType<typeof requireActor>;
