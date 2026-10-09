/**
 * The purchase agent's only authority over Cubby: one Run's services. Each
 * call opens its own database scope. Research effects delegate to the bound
 * research factory; lifecycle and photo-only effects retain their existing
 * host contracts. Research authority, evidence, and replay belong to that factory. Flow: `server/purchase-import/README.md`.
 */
import {
  agentImportRunPurpose,
  type AgentImportRunPurpose,
} from "@cubby/schemas/import-run-agent";
import {
  agentProgressReport,
  agentUsageEvent,
  markRunFailedInput,
  purchaseAgentEventRef,
  purchaseAgentOperationRef,
  reconcileSettledRunInput,
  stopForReviewInput,
} from "@cubby/schemas/purchase-agent-services";
import { sha256Uuid } from "@cubby/shared/sha256";

import { assertNotInMaintenance } from "~/server/maintenance";
import type { RunServices } from "~/server/purchase-agent/environment";

import { getTestAiGateway, runWithExecutionCtx, setCfEnv } from "../cf-env";

/** The MCP endpoint the delegation bearer's audience names. */
const MCP_URL = "https://cubby.internal/api/mcp";

type HostContext = { waitUntil(promise: Promise<unknown>): void };

/** The services of `runId`, executing with this Worker's bindings. */
export function runServicesFor(
  env: Env,
  ctx: HostContext,
  runId: string,
): RunServices {
  const withDatabase = <T>(
    fn: (
      database: typeof import("~/server/db").db,
      service: typeof import("./run-service"),
      operation: typeof import("~/server/runs/operation"),
    ) => Promise<T>,
  ): Promise<T> => {
    assertNotInMaintenance(env);
    setCfEnv(env);
    return runWithExecutionCtx(ctx, async () => {
      const { db, withRequestDbClient } = await import("~/server/db");
      return withRequestDbClient(env.HYPERDRIVE.connectionString, async () =>
        fn(
          db,
          await import("./run-service"),
          await import("~/server/runs/operation"),
        ),
      );
    });
  };

  const requirePhotoScope = async (
    db: typeof import("~/server/db").db,
    service: typeof import("./run-service"),
  ) => {
    const scope = await service.loadRunScope(db, runId);
    if (scope.public.purpose !== "photo_inventory")
      throw new Error(
        "This host service is available only to photo inventory Runs",
      );
    return scope;
  };
  const withPhotoDatabase: typeof withDatabase = (fn) =>
    withDatabase(async (db, service, operation) => {
      await requirePhotoScope(db, service);
      return fn(db, service, operation);
    });
  const withResearch = <T>(
    fn: (
      service: ReturnType<
        typeof import("./research-service").researchServiceFor
      >,
    ) => Promise<T>,
  ) =>
    withDatabase(async (db) => {
      const { assertResearchRunExecutable } =
        await import("./research-execution");
      await assertResearchRunExecutable(db, runId);
      const { researchServiceFor } = await import("./research-service");
      const { researchFixtureSources } =
        await import("./research-source-transport");
      return fn(
        researchServiceFor(db, env, runId, {
          observations: await researchFixtureSources(getTestAiGateway()),
        }),
      );
    });

  return {
    processResearchRetention: (receiptId) =>
      withDatabase(async (db) => {
        const { processBoundResearchRetention } =
          await import("./research-retention-runtime");
        return processBoundResearchRetention(db, env, { runId, receiptId });
      }),
    researchCoordinatorStatus: () =>
      withDatabase(async (db) => {
        const { researchCoordinatorStatus } =
          await import("./research-execution");
        return researchCoordinatorStatus(db, runId);
      }),
    authorizeResearchRetirement: (receiptId) =>
      withDatabase(async (db) => {
        const { authorizeResearchCoordinatorRetirement } =
          await import("./research-retention");
        await authorizeResearchCoordinatorRetirement(db, { runId, receiptId });
      }),
    loadScope: () =>
      withDatabase(async (db, service) => {
        const scope = await service.loadRunScope(db, runId);
        return {
          purpose: agentImportRunPurpose.parse(scope.public.purpose),
          agentId: scope.public.agentId,
        };
      }),

    canDispatchCoordinator: (eventId) =>
      withDatabase((db, service) =>
        service.canDispatchRunCoordinator(db, {
          runId,
          ...purchaseAgentEventRef.parse({ eventId }),
        }),
      ),

    acknowledgeCoordinator: (eventId) =>
      withDatabase((db, service) =>
        service.acknowledgeRunCoordinator(db, {
          runId,
          ...purchaseAgentEventRef.parse({ eventId }),
        }),
      ),

    authorize: () =>
      withDatabase(async (db, service) => {
        const scope = await service.loadRunScope(db, runId);
        const { findActivePurchaseAgentGrant } = await import("./agent-auth");
        if (await findActivePurchaseAgentGrant(db, scope.actorUserId)) return;
        await service.pauseRunForAuthorization(db, runId);
        throw new Error("Purchase Agent authorization is required");
      }),

    mcpFetch: async (request) => {
      // Read the agent's request before entering the database scope, so no
      // agent-supplied code runs inside it.
      const target = new URL(MCP_URL);
      target.search = new URL(request.url).search;
      const headers = new Headers(request.headers);
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      return withDatabase(async (db, service) => {
        const scope = await requirePhotoScope(db, service);
        const [
          { findActivePurchaseAgentGrant, issuePurchaseAgentDelegation },
          { handleMcpHttpRequest },
        ] = await Promise.all([
          import("./agent-auth"),
          import("~/server/mcp/http-handler"),
        ]);
        const grant = await findActivePurchaseAgentGrant(db, scope.actorUserId);
        if (!grant) {
          await service.pauseRunForAuthorization(db, runId);
          throw new Error("Purchase Agent authorization is required");
        }
        // A fresh run-bound bearer per request; the MCP handler verifies it,
        // the live grant, and LedgerParty ownership exactly as for any client.
        headers.set(
          "authorization",
          `Bearer ${await issuePurchaseAgentDelegation({
            runId,
            userId: scope.actorUserId,
            grantId: grant.id,
            secret: env.BETTER_AUTH_SECRET,
          })}`,
        );
        return handleMcpHttpRequest(
          new Request(target, { method: request.method, headers, body }),
        );
      });
    },

    researchNext: (input, callId) =>
      withResearch((service) => service.researchNext(input, callId)),
    researchObserve: (input, callId) =>
      withResearch((service) => service.researchObserve(input, callId)),
    researchResolve: (input, callId) =>
      withResearch((service) => service.researchResolve(input, callId)),
    researchMailSearch: (input, callId) =>
      withResearch((service) => service.researchMailSearch(input, callId)),
    researchMailRead: (input, callId) =>
      withResearch((service) => service.researchMailRead(input, callId)),
    researchWebSearch: (input, callId) =>
      withResearch((service) => service.researchWebSearch(input, callId)),
    researchWebRead: (input, callId) =>
      withResearch((service) => service.researchWebRead(input, callId)),
    researchFind: (input, callId) =>
      withResearch((service) => service.researchFind(input, callId)),
    researchResume: (signal) =>
      withResearch((service) => service.researchResume(signal)),
    researchAcknowledge: (signal) =>
      withResearch((service) => service.researchAcknowledge(signal)),

    claimNextWork: (input) => {
      const ref = purchaseAgentOperationRef.parse(input);
      return withPhotoDatabase((db, service, operation) =>
        operation.executeLeasedOperation(
          db,
          {
            runId,
            ...ref,
            kind: "claim_next_work",
            payload: { runId, ...ref },
          },
          () => service.claimPhotoInventoryWork(db, runId),
        ),
      );
    },

    recordAgentUsage: (input) => {
      const event = agentUsageEvent.parse(input);
      return withDatabase(async (db) => {
        const [{ recordAiUsage }, { runEntityId }] = await Promise.all([
          import("~/server/ai/usage"),
          import("@cubby/schemas/identifiers"),
        ]);
        await recordAiUsage(db, {
          ...event,
          eventId: await sha256Uuid(`purchase-agent:${runId}:${event.eventId}`),
          runId: runEntityId.parse(runId),
          // Prompt-cache traffic is token evidence, not a caller cache.
          cacheStatus: "none",
        });
      });
    },

    updateAgentProgress: (input) => {
      const report = agentProgressReport.parse(input);
      return withDatabase((db, service) =>
        service.updateAgentProgress(db, { runId, ...report }),
      );
    },

    stopForReview: (input) => {
      const payload = { runId, ...stopForReviewInput.parse(input) };
      return withPhotoDatabase((db, service, operation) =>
        operation.executeLeasedOperation(
          db,
          { ...payload, kind: "stop_for_review", payload },
          () =>
            service.stopRunForReview(db, {
              runId,
              operationId: payload.operationId,
              kind:
                payload.reason === "navigation_ambiguity"
                  ? "expected_order_not_found"
                  : "other",
              summary: payload.detail ?? payload.reason.replaceAll("_", " "),
            }),
        ),
      );
    },

    markRunFailed: (input) => {
      const payload = { runId, ...markRunFailedInput.parse(input) };
      return withDatabase((db, service, operation) =>
        operation.executeLeasedOperation(
          db,
          { ...payload, kind: "mark_run_failed", payload },
          () => service.markRunFailed(db, payload),
        ),
      );
    },

    reconcileSettledRun: (input) => {
      const parsed = reconcileSettledRunInput.parse(input);
      const payload = {
        ...parsed,
        runId,
        receivedEventIds: new Set(parsed.receivedEventIds),
      };
      return withDatabase((db, service) =>
        service.reconcileSettledRun(db, env.PURCHASE_IMPORT, payload),
      );
    },
  };
}

/**
 * The purpose's Cubby MCP tools, described exactly as the MCP server lists
 * them to that purpose's agent: the same compiled catalog narrowed to the
 * manifest's actions (`purchaseAgentToolCatalog`).
 */
export async function purchaseAgentMcpTools(purpose: AgentImportRunPurpose) {
  const { purchaseAgentToolCatalog } =
    await import("~/server/mcp/agent-tool-catalog");
  return purchaseAgentToolCatalog(purpose);
}
