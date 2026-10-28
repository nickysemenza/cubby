import { runEntityId } from "@cubby/schemas/identifiers";
/**
 * The import agent's only authority over Cubby: one Run's services. Each call
 * opens its own database scope. Domain writes travel through the Run's
 * delegated Cubby MCP actions; these services own lifecycle, progress and
 * accounting. Flow: `server/domains/purchase-import/service/README.md`.
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
import { z } from "zod";

import { runWithExecutionCtx, withCfEnv } from "~/server/cf-env";
import type {
  PurchaseDispatchEnvironment,
  RunServices,
} from "~/server/domains/purchase-agent/service/environment";
import { getAuthSecret } from "~/server/http/auth-configuration";
import { assertNotInMaintenance } from "~/server/http/maintenance";

/** The MCP endpoint the delegation bearer's audience names. */
const MCP_URL = "https://cubby.internal/api/mcp";

type HostContext = { waitUntil(promise: Promise<unknown>): void };

/** One database scope with this Worker's bindings. */
function withHostDatabase<T>(
  env: Env,
  ctx: HostContext,
  fn: (
    database: typeof import("~/server/db").db,
    service: typeof import("../repo/run-service"),
    operation: typeof import("~/server/domains/run/repo/operation"),
  ) => Promise<T>,
): Promise<T> {
  assertNotInMaintenance(env);
  return withCfEnv(env, () =>
    runWithExecutionCtx(ctx, async () => {
      const { db, withInvocationDb } = await import("~/server/db");
      return withInvocationDb(env.HYPERDRIVE.connectionString, async () =>
        fn(
          db,
          await import("../repo/run-service"),
          await import("~/server/domains/run/repo/operation"),
        ),
      );
    }),
  );
}

const ADMISSION_ATTEMPTS = 3;

/**
 * Frontier admission runs before every coordinator model call, so a transient
 * pool-slot timeout there failed whole Runs (2026-10-19). Retry those; a final
 * failure keeps its Postgres cause in the message, the only part Workers RPC
 * carries back to the coordinator.
 */
export async function admissionRead<T>(
  read: () => Promise<T>,
  wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  const { findPgError, isTransientConnectionError } =
    await import("~/server/errors/db-errors");
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error: unknown) {
      if (attempt < ADMISSION_ATTEMPTS && isTransientConnectionError(error)) {
        await wait(250 * attempt * attempt);
        continue;
      }
      const pg = findPgError(error);
      // A bare Postgres error already carries its own message.
      if (
        pg?.message &&
        error instanceof Error &&
        !error.message.includes(pg.message)
      )
        throw new Error(`${error.message}\ncause: ${pg.code} ${pg.message}`, {
          cause: error,
        });
      throw error;
    }
  }
}

/** Retirement of a legacy coordinator, named by its stored session id. */
export function authorizeLegacyRetirement(
  env: Env,
  ctx: HostContext,
  agentSessionId: string,
) {
  return withHostDatabase(env, ctx, async (db) => {
    const { assertRetirableLegacySession } =
      await import("../repo/run-retirement");
    await assertRetirableLegacySession(db, agentSessionId);
  });
}

/**
 * The dispatch handler's environment: any Run's services and coordinator.
 * It lives here, not beside the Durable Object, so the Job handler graph
 * (which the Start transport reaches) never imports `cloudflare:workers`.
 */
export function purchaseDispatchEnvironment(
  env: Env,
  ctx: HostContext,
): PurchaseDispatchEnvironment {
  return {
    run: (runId) => runServicesFor(env, ctx, runId),
    coordinator: (agentId) => env.PURCHASE_IMPORT_RUN.getByName(agentId),
  };
}

/** The services of `runId`, executing with this Worker's bindings. */
export function runServicesFor(
  env: Env,
  ctx: HostContext,
  rawRunId: string,
): RunServices {
  const runId = runEntityId.parse(rawRunId);
  const withDatabase = <T>(
    fn: Parameters<typeof withHostDatabase<T>>[2],
  ): Promise<T> => withHostDatabase(env, ctx, fn);

  const requireAgentScope = async (
    db: typeof import("~/server/db").db,
    service: typeof import("../repo/run-service"),
  ) => {
    const scope = await service.loadRunScope(db, runId);
    if (
      scope.public.purpose !== "photo_inventory" &&
      scope.public.purpose !== "mail_import"
    )
      throw new Error(
        "This host service is available only to Mail import and photo inventory Runs",
      );
    return scope;
  };
  const withAgentDatabase: typeof withDatabase = (fn) =>
    withDatabase(async (db, service, operation) => {
      await requireAgentScope(db, service);
      return fn(db, service, operation);
    });
  return {
    admitPaidInference: (request) =>
      admissionRead(() =>
        withDatabase(async (db) => {
          const [{ paidRunPreflight }, { runEntityId }] = await Promise.all([
            import("~/server/domains/run/service/execution-transport"),
            import("@cubby/schemas/identifiers"),
          ]);
          await paidRunPreflight(db, runEntityId.parse(runId))(request);
        }),
      ),
    admitFreeInference: (request, funding) =>
      admissionRead(() =>
        withDatabase(async (db) => {
          const [{ freeRunPreflight }, { runEntityId }] = await Promise.all([
            import("~/server/domains/run/service/execution-transport"),
            import("@cubby/schemas/identifiers"),
          ]);
          return freeRunPreflight(db, runEntityId.parse(runId))(
            request,
            funding,
          );
        }),
      ),
    escalationUnavailable: (model) =>
      admissionRead(() =>
        withDatabase(async (db) => {
          const [{ escalationFundingRefusal }, { runEntityId }] =
            await Promise.all([
              import("~/server/ai/funding"),
              import("@cubby/schemas/identifiers"),
            ]);
          return escalationFundingRefusal(db, runEntityId.parse(runId), model);
        }),
      ),
    coordinatorRetired: () =>
      withDatabase(async (db) => {
        const { coordinatorRetired } = await import("../repo/run-retirement");
        return coordinatorRetired(db, runId);
      }),
    authorizeRetirement: () =>
      withDatabase(async (db) => {
        const { assertRetirableRun } = await import("../repo/run-retirement");
        return assertRetirableRun(db, runId);
      }),
    loadScope: () =>
      withDatabase(async (db, service) => {
        const scope = await service.loadRunScope(db, runId);
        return {
          purpose: agentImportRunPurpose.parse(scope.public.purpose),
          agentId: scope.public.agentId,
          generation: scope.public.dispatchEventId,
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
        const { findActivePurchaseAgentGrant } =
          await import("~/server/domains/purchase-import/repo/agent-auth");
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
        const scope = await requireAgentScope(db, service);
        const [
          { findActivePurchaseAgentGrant, issuePurchaseAgentDelegation },
          { handleMcpHttpRequest },
        ] = await Promise.all([
          import("~/server/domains/purchase-import/repo/agent-auth"),
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
            generation: stampedGeneration(body),
            secret: getAuthSecret(),
          })}`,
        );
        return handleMcpHttpRequest(
          new Request(target, { method: request.method, headers, body }),
        );
      });
    },

    claimNextWork: (input) => {
      const ref = purchaseAgentOperationRef.parse(input);
      return withAgentDatabase(async (db, service, operation) => {
        const scope = await service.loadRunScope(db, runId);
        return operation.executeLeasedOperation(
          db,
          {
            runId,
            ...ref,
            kind: "claim_next_work",
            payload: { runId, ...ref },
          },
          async () =>
            scope.public.purpose === "mail_import"
              ? (await import("./mail-import-claim")).claimMailImportWork(
                  db,
                  runId,
                )
              : service.claimPhotoInventoryWork(db, runId),
        );
      });
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
      return withAgentDatabase((db, _service, operation) =>
        operation.executeLeasedOperation(
          db,
          { ...payload, kind: "stop_for_review", payload },
          async () =>
            (await import("./run-review")).stopRunForReview(db, {
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
      return withDatabase(async (db) =>
        (await import("./run-review")).reconcileSettledRun(db, payload),
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

/**
 * The coordinator generation the agent host stamped on a `tools/call`
 * envelope (`cubby-mcp`), signed into that request's delegation so the MCP
 * handler can fence writes from a superseded generation.
 */
function stampedGeneration(body: ArrayBuffer | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const message: unknown = JSON.parse(new TextDecoder().decode(body));
    const parsed = z
      .object({
        method: z.literal("tools/call"),
        params: z.object({
          arguments: z.object({
            _runExecution: z.object({ generation: z.string().min(1) }),
          }),
        }),
      })
      .safeParse(message);
    return parsed.success
      ? parsed.data.params.arguments._runExecution.generation
      : undefined;
  } catch {
    return undefined;
  }
}
