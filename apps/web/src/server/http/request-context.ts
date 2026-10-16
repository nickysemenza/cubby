import {
  type ActorContext,
  type AuditChannel,
  buildActorContext,
} from "@cubby/schemas/context";
import {
  type DeviceId,
  type RunId,
  type UserId,
  userId,
} from "@cubby/schemas/identifiers";
import type { SpanAttr } from "@cubby/worker-tracing";
import { and, eq } from "drizzle-orm";

import { env } from "~/env";
// Static on purpose: importing auth lazily inside a Worker request left the
// purchase agent's MCP tool calls unanswered (#2536).
import { auth as betterAuth } from "~/lib/auth";
import type { NotionClient } from "~/server/clients/notion";
import { createUpcLookupService } from "~/server/clients/upc";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { boundedStaleDb, db } from "~/server/db";
import { readDatabaseFreshness } from "~/server/db/freshness/client";
import { getDb } from "~/server/db/helpers/core";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  decideReadConsistency,
  type ReadConsistencyDecision,
} from "~/server/db/read-consistency";
import { device } from "~/server/db/schema";
import type { ExpenseLineRoleClassifier } from "~/server/domains/expense/repo/line-role-classifier";
import { currentMemberLedgerParty } from "~/server/domains/ledger-party/repo/current-member-party";
import type { RecipeCostingService } from "~/server/domains/recipe/repo/recipe-costing";
import type { AvailabilityService } from "~/server/domains/recipe/service/availability.service";
import type { USDAService } from "~/server/domains/usda-food/service/usda.service";
import type { UsdaReleaseRpc } from "~/server/domains/usda-release/operations/rpc";
import { createAppError } from "~/server/errors/app-error";
import { deferredService } from "~/server/http/deferred-service";
import type { RequestOrigin } from "~/server/http/workload";
import { annotateActiveSpan } from "~/server/observability/tracing";

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
      expenseLineRole: (async (db, actor, evidence) =>
        (await loaded()).services.expenseLineRole(
          db,
          actor,
          evidence,
        )) satisfies ExpenseLineRoleClassifier,
    },
  };
};

export const buildCrudServices = (
  database: Database,
  opts?: { usdaRelease?: UsdaReleaseRpc },
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
  const usdaClient = deferredService<USDAClient>(
    async () =>
      new (await import("~/server/clients/usda")).USDAClient(
        opts?.usdaRelease ??
          (
            await import("~/server/domains/usda-release/service/client")
          ).requestUsdaRelease(),
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

export type { CurrentParty } from "~/server/domains/ledger-party/repo/current-member-party";

/** Resolve the authenticated member's claimed ledger party at use time. */
export const currentParty = (database: Database, authenticatedUserId: UserId) =>
  currentMemberLedgerParty(database, { userId: authenticatedUserId });

/**
 * Trace attributes naming the actor. The active span when the context is built
 * may be a short authentication span, so operation spans that reuse a context
 * apply these again themselves.
 */
export const actorSpanAttributes = (
  sessionId: string | null,
  actor: ActorContext,
) =>
  ({
    "user.id": actor.userId,
    "session.id": sessionId ?? undefined,
    "cubby.auth.channel": actor.channel,
    "cubby.auth.oauth_client_id": actor.oauthClientId ?? undefined,
    "cubby.run.id": actor.runId ?? undefined,
    "cubby.device.id": actor.deviceId ?? undefined,
  }) satisfies Record<string, SpanAttr>;

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
    const actorContext = buildActorContext(userId, channel, {
      oauthClientId,
      deviceId,
      runId,
    });
    crudServices.upcLookupClient.bindActorContext(actorContext);
    annotateActiveSpan(actorSpanAttributes(sessionId, actorContext));
    return {
      ...crudServices,
      readConsistency,
      auth: { userId, sessionId },
      currentParty: async () => await currentParty(crudServices.db, userId),
      actorContext,
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
  const sessionId = betterSession?.session?.id ?? null;
  const actorContext = authenticatedUserId
    ? buildActorContext(authenticatedUserId, "web", { deviceId })
    : null;
  if (actorContext) crudServices.upcLookupClient.bindActorContext(actorContext);
  if (actorContext)
    annotateActiveSpan(actorSpanAttributes(sessionId, actorContext));
  return {
    ...crudServices,
    readConsistency,
    auth: { userId: authenticatedUserId, sessionId },
    currentParty: authenticatedUserId
      ? async () => await currentParty(crudServices.db, authenticatedUserId)
      : null,
    actorContext,
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
