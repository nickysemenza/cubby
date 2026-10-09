/**
 * The purchase agent's only authority over Cubby: one Run's services. Each
 * call opens its own database scope. Research effects delegate to the bound
 * research factory; lifecycle and photo-only effects retain their existing
 * host contracts. Research authority, evidence, and replay belong to that factory. Flow: `server/purchase-import/README.md`.
 */
import { runEntityId } from "@cubby/schemas/identifiers";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
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

import { recordAiUsage } from "~/server/ai/usage";
import type { Database } from "~/server/db";
import { handleMcpHttpRequest } from "~/server/mcp/http-handler";
import type {
  PurchaseAgentQueueBatch,
  PurchaseAgentQueueEnvironment,
  RunServices,
} from "~/server/purchase-agent/environment";
import { consumePurchaseAgentQueue } from "~/server/purchase-agent/queue";
import { paidResearchPreflight } from "~/server/runs/execution-transport";
import * as operation from "~/server/runs/operation";

import { getTestAiGateway } from "../cf-env";
import {
  findActivePurchaseAgentGrant,
  issuePurchaseAgentDelegation,
} from "./agent-auth";
import { withHostDatabase } from "./host-database";
import {
  assertResearchRunExecutable,
  researchCoordinatorStatus,
} from "./research-execution";
import { authorizeResearchCoordinatorRetirement } from "./research-retention";
import { processBoundResearchRetention } from "./research-retention-runtime";
import { researchServiceFor } from "./research-service";
import { researchFixtureSources } from "./research-source-transport";
import * as runService from "./run-service";

/** The MCP endpoint the delegation bearer's audience names. */
const MCP_URL = "https://cubby.internal/api/mcp";

type HostContext = { waitUntil(promise: Promise<unknown>): void };

/**
 * The Worker entry's `cubby-purchase-agent` consumer. It holds no database
 * client: each Run service it calls opens its own.
 */
export function consumePurchaseAgentBatch(
  batch: PurchaseAgentQueueBatch,
  env: Env,
  ctx: HostContext,
) {
  const environment: PurchaseAgentQueueEnvironment = {
    run: (runId) => runServicesFor(env, ctx, runId),
    coordinator: (agentId) => env.PURCHASE_IMPORT_RUN.getByName(agentId),
  };
  return consumePurchaseAgentQueue(batch, environment);
}

/** The services of `runId`, executing with this Worker's bindings. */
export function runServicesFor(
  env: Env,
  ctx: HostContext,
  runId: string,
): RunServices {
  const withDatabase = <T>(
    fn: (
      database: Database,
      service: typeof runService,
      leased: typeof operation,
    ) => Promise<T>,
  ): Promise<T> =>
    withHostDatabase(env, ctx, (db) => fn(db, runService, operation));

  const requirePhotoScope = async (
    db: Database,
    service: typeof runService,
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
    fn: (service: ReturnType<typeof researchServiceFor>) => Promise<T>,
  ) =>
    withDatabase(async (db) => {
      await assertResearchRunExecutable(db, runId);
      return fn(
        researchServiceFor(db, env, runId, {
          observations: await researchFixtureSources(getTestAiGateway()),
        }),
      );
    });

  return {
    processResearchRetention: (receiptId) =>
      withDatabase((db) =>
        processBoundResearchRetention(db, env, { runId, receiptId }),
      ),
    admitPaidInference: (request) =>
      withDatabase(async (db) => {
        await paidResearchPreflight(db, runEntityId.parse(runId))(request);
      }),
    researchCoordinatorStatus: () =>
      withDatabase((db) => researchCoordinatorStatus(db, runId)),
    authorizeResearchRetirement: (receiptId) =>
      withDatabase(async (db) => {
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
    researchContinue: (callId, admitted) =>
      withResearch((service) => service.researchContinue(callId, admitted)),
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
