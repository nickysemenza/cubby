/**
 * The purchase agent's only authority over Cubby: one Run's services. Each
 * method parses its input (`@cubby/schemas/purchase-agent-services`), opens
 * its own database scope, and resolves every target from the bound Run; the
 * caller cannot supply a Run, party, account, vendor, SQL, script, or generic
 * mutation target. Flow: `server/purchase-import/README.md`.
 */
import {
  agentImportRunPurpose,
  type AgentImportRunPurpose,
} from "@cubby/schemas/import-run-agent";
import {
  agentProgressReport,
  agentUsageEvent,
  deferOrderForReviewInput,
  importOrderEvidenceInput,
  issueBrowserCommandInput,
  markHistoryExpiredInput,
  markRunFailedInput,
  purchaseAgentEventRef,
  purchaseAgentOperationRef,
  reconcileSettledRunInput,
  saveNavigationHintsInput,
  settleChargeHuntInput,
  stopForReviewInput,
} from "@cubby/schemas/purchase-agent-services";
import { sha256Uuid } from "@cubby/shared/sha256";

import type { RunServices } from "~/server/purchase-agent/environment";

import { runWithExecutionCtx, setCfEnv } from "../cf-env";
import { resolvePurchaseAgentBrowserOperation } from "./agent-browser-command";

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

  return {
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
        const scope = await service.loadRunScope(db, runId);
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

    claimNextWork: (input) => {
      const ref = purchaseAgentOperationRef.parse(input);
      return withDatabase((db, service, operation) =>
        operation.executeLeasedOperation(
          db,
          {
            runId,
            ...ref,
            kind: "claim_next_work",
            payload: { runId, ...ref },
          },
          () => service.claimNextImportWork(db, env.PURCHASE_IMPORT, runId),
        ),
      );
    },

    extractReceiptEvidence: (input) => {
      const ref = purchaseAgentOperationRef.parse(input);
      return withDatabase((db, _service, operation) =>
        operation.executeLeasedOperation(
          db,
          {
            runId,
            ...ref,
            kind: "extract_receipt_evidence",
            payload: { runId, ...ref },
          },
          async () => {
            const [{ extractPurchaseReceipt }, { loadReceiptEvidenceForRun }] =
              await Promise.all([
                import("~/server/agents/purchase-import/extract"),
                import("./receipt-evidence"),
              ]);
            const evidence = await loadReceiptEvidenceForRun(db, runId);
            if (!evidence)
              throw new Error("This run has no pending receipt evidence");
            const extraction = await extractPurchaseReceipt({
              db,
              runId,
              imageUrl: evidence.imageUrl,
            });
            return {
              stableOrderId: `receipt:${evidence.huntId}`,
              itemOperationId: `receipt:${evidence.huntId}`,
              source: evidence.source,
              evidenceChecksum: evidence.evidenceChecksum,
              extractionRevision: "receipt@1",
              extraction,
              lineIds: (extraction.candidate?.lines ?? []).map(
                (_line, index) => `receipt:${evidence.huntId}:line:${index}`,
              ),
              primaryDocumentImageId: evidence.imageId,
              screenshotImageId: null,
            };
          },
        ),
      );
    },

    extractRunEvidence: (input) => {
      const ref = purchaseAgentOperationRef.parse(input);
      return withDatabase((db, _service, operation) =>
        operation.executeLeasedOperation(
          db,
          {
            runId,
            ...ref,
            kind: "extract_run_evidence",
            payload: { runId, ...ref },
          },
          async () => {
            const { loadOrderMailImportEvidence } =
              await import("./gmail/import");
            const mail = await loadOrderMailImportEvidence(db, runId);
            if (mail) {
              const { extractPurchaseOrderMail } =
                await import("~/server/agents/purchase-import/extract");
              const extraction = await extractPurchaseOrderMail({
                db,
                runId,
                mail: mail.mail,
                orderId: mail.orderId,
                productHosts: mail.productHosts,
              });
              const stableOrderId = `mail:${mail.eventId}`;
              return {
                stableOrderId,
                itemOperationId: stableOrderId,
                source: mail.source,
                evidenceChecksum: mail.evidenceChecksum,
                extractionRevision: "order-mail@1",
                extraction,
                lineIds: (extraction.candidate?.lines ?? []).map(
                  (_line, index) => `${stableOrderId}:line:${index}`,
                ),
                primaryDocumentImageId: null,
                screenshotImageId: null,
              };
            }
            const [
              { extractPurchaseEvidence },
              { loadRunEvidenceForExtraction },
            ] = await Promise.all([
              import("~/server/agents/purchase-import/extract"),
              import("./run-evidence"),
            ]);
            const evidence = await loadRunEvidenceForExtraction(db, runId);
            if (!evidence)
              throw new Error("This validation run has no uploaded evidence");
            const extraction = await extractPurchaseEvidence({
              db,
              runId,
              evidenceUrl: evidence.evidenceUrl,
              mediaType: evidence.mediaType,
            });
            return {
              stableOrderId: `run-evidence:${evidence.id}`,
              itemOperationId: `run-evidence:${evidence.id}`,
              source: {
                kind: evidence.sourceKind ?? "receipt_photo",
                externalKey: evidence.sourceExternalKey ?? evidence.id,
                checksum: evidence.checksum,
              },
              evidenceChecksum: evidence.checksum,
              extractionRevision: "run-evidence@1",
              extraction,
              lineIds: (extraction.candidate?.lines ?? []).map(
                (_line, index) => `run-evidence:${evidence.id}:line:${index}`,
              ),
              primaryDocumentImageId: null,
              screenshotImageId: null,
            };
          },
        ),
      );
    },

    issueBrowserCommand: (input) => {
      const parsed = issueBrowserCommandInput.parse(input);
      return withDatabase(async (db, service) => {
        const scope = await service.loadRunScope(db, runId);
        if (!scope.public.vendorAccountId)
          throw new Error("This import run has no browser account");
        const claimed = await service.claimNextImportWork(
          db,
          env.PURCHASE_IMPORT,
          runId,
        );
        const claimedTarget = "startUrl" in claimed ? claimed.startUrl : null;
        return service.issueBrowserCommand(db, env.PURCHASE_IMPORT, {
          runId,
          operationId: parsed.operationId,
          operation: resolvePurchaseAgentBrowserOperation(
            parsed.command,
            claimedTarget,
            scope.public.allowedHosts,
          ),
        });
      });
    },

    readBrowserCommandResult: (input) => {
      const ref = purchaseAgentOperationRef.parse(input);
      return withDatabase((db, service) =>
        service.readBrowserCommandResult(db, env.PURCHASE_IMPORT, {
          runId,
          ...ref,
        }),
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

    importOrderEvidence: (input) => {
      const parsed = importOrderEvidenceInput.parse(input);
      const payload = { runId, ...parsed };
      return withDatabase((db, service, operation) =>
        operation.executeLeasedOperation(
          db,
          { ...payload, kind: "import_order_evidence", payload },
          () =>
            service.importBrowserOrderEvidence(
              db,
              env.PURCHASE_IMPORT,
              payload,
            ),
        ),
      );
    },

    saveNavigationHints: (input) => {
      const parsed = saveNavigationHintsInput.parse(input);
      const payload = { runId, ...parsed };
      return withDatabase((db, service, operation) =>
        operation.executeLeasedOperation(
          db,
          { ...payload, kind: "save_navigation_hints", payload },
          () =>
            service.saveNavigationHints(db, {
              runId,
              operationId: parsed.operationId,
              patch: {
                ordersListUrl: parsed.hints[0]?.url,
                notes: parsed.hints
                  .map((hint) => hint.label)
                  .filter((label): label is string => Boolean(label)),
              },
            }),
        ),
      );
    },

    markHistoryExpired: (input) => {
      const payload = { runId, ...markHistoryExpiredInput.parse(input) };
      return withDatabase((db, service, operation) =>
        operation.executeLeasedOperation(
          db,
          { ...payload, kind: "mark_history_expired", payload },
          () => service.markHistoryExpired(db, payload),
        ),
      );
    },

    finishRun: (input) => {
      const payload = { runId, ...purchaseAgentOperationRef.parse(input) };
      return withDatabase((db, service, operation) =>
        operation.executeLeasedOperation(
          db,
          { ...payload, kind: "finish_run", payload },
          () => service.finishRun(db, env.PURCHASE_IMPORT, payload),
        ),
      );
    },

    stopForReview: (input) => {
      const payload = { runId, ...stopForReviewInput.parse(input) };
      return withDatabase((db, service, operation) =>
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

    deferOrderForReview: (input) => {
      const payload = { runId, ...deferOrderForReviewInput.parse(input) };
      return withDatabase((db, service, operation) =>
        operation.executeLeasedOperation(
          db,
          { ...payload, kind: "defer_order_for_review", payload },
          () =>
            service.deferOrderForReview(db, {
              runId,
              operationId: payload.operationId,
              orderId: payload.orderId,
              summary: payload.detail,
            }),
        ),
      );
    },

    settleChargeHunt: (input) => {
      const payload = { runId, ...settleChargeHuntInput.parse(input) };
      return withDatabase((db, service, operation) =>
        operation.executeLeasedOperation(
          db,
          { ...payload, kind: "settle_charge_hunt", payload },
          () =>
            service.settleChargeHunt(db, {
              runId,
              operationId: payload.operationId,
              huntId: payload.huntId,
              outcome: payload.outcome,
              summary: payload.detail,
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
