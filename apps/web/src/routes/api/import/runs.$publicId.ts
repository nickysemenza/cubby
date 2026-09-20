import { createFileRoute } from "@tanstack/react-router";

import {
  importRunPublicId,
  purchaseImportRunControlInput,
  purchaseImportRunControlResponse,
  purchaseImportRunDetailError,
  purchaseImportRunDetailResponse,
} from "~/lib/purchase-import-run-detail";
import { getPurchaseAgentQueue } from "~/server/cf-env";
import {
  controlImportRun,
  loadImportRunByPublicId,
} from "~/server/purchase-import/run-service";
import { createRequestContext, requireActor } from "~/server/request-context";

const notFound = () =>
  Response.json({ error: "Import run was not found" }, { status: 404 });

const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Strip internal ids and operation payloads before the browser receives a run. */
const browserRun = (
  run: Awaited<ReturnType<typeof loadImportRunByPublicId>>,
) => ({
  publicId: run.publicId,
  status: run.status,
  trigger: run.trigger,
  source: run.source,
  actor: {
    name: run.actor.name,
    ledgerParty: {
      id: run.actor.ledgerParty.id,
      name: run.actor.ledgerParty.name,
    },
  },
  vendorAccount: run.vendorAccount,
  startedAt: run.startedAt.toISOString(),
  endedAt: iso(run.endedAt),
  ordersSeen: run.ordersSeen,
  imported: run.imported,
  updated: run.updated,
  skipped: run.skipped,
  failureCode: run.failureCode,
  predecessorRunPublicId: run.predecessorRunPublicId,
  successorRunPublicId: run.successorRunPublicId,
  coordinatorModel: run.coordinatorModel,
  skillRevision: run.skillRevision,
  runtimeRevision: run.runtimeRevision,
  operations: run.operations.map((operation) => ({
    operationId: operation.operationId,
    kind: operation.kind,
    state: operation.state,
    startedAt: operation.startedAt.toISOString(),
    completedAt: iso(operation.completedAt),
    error: operation.error,
  })),
  preparedOrders: run.preparedOrders.map((order) => ({
    stableOrderId: order.stableOrderId,
    itemOperationId: order.itemOperationId,
    sourceKind: order.sourceKind,
    externalKey: order.externalKey,
    preparedAt: order.preparedAt.toISOString(),
    lineCount: order.lineCount,
  })),
  approvals: run.approvals.map((approval) => ({
    id: approval.id,
    operationId: approval.operationId,
    operationKind: approval.operationKind,
    args: approval.args,
    state: approval.state,
    grantedAt: approval.state === "granted" ? iso(approval.decidedAt) : null,
    consumedAt: iso(approval.consumedAt),
    invalidatedAt: iso(approval.invalidatedAt),
    rejectedAt: iso(approval.rejectedAt),
  })),
  affectedPurchases: run.affectedPurchases.map((purchase) => ({
    shortcode: purchase.id,
    displayName: purchase.displayLabel,
    orderId: purchase.orderId,
  })),
  findings: run.findings.map((finding) => ({
    ...finding,
    createdAt: finding.createdAt.toISOString(),
    expiresAt: iso(finding.expiresAt),
  })),
  controllingMembers: run.controllingMembers.map((member) => ({
    name: member.name,
    ledgerParty: {
      id: member.ledgerParty.id,
      name: member.ledgerParty.name,
    },
  })),
  controlHistory: run.controlHistory.map((event) => ({
    action: event.action,
    name: event.name,
    ledgerParty: {
      id: event.ledgerPartyId,
      name: event.ledgerPartyName,
    },
    createdAt: event.createdAt.toISOString(),
  })),
  progress: run.progress.map((event) => ({
    ...event,
    createdAt: event.createdAt.toISOString(),
  })),
  latestProgress: run.latestProgress
    ? {
        ...run.latestProgress,
        createdAt: run.latestProgress.createdAt.toISOString(),
      }
    : null,
  usage: {
    pricedSubtotal: run.usage.pricedSubtotal,
    unpricedCount: run.usage.unpricedCount,
    records: run.usage.records.map((record) => ({
      ...record,
      createdAt: record.createdAt.toISOString(),
    })),
    nextCursor: run.usage.nextCursor,
  },
});

export const Route = createFileRoute("/api/import/runs/$publicId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const publicId = importRunPublicId.safeParse(params.publicId);
        if (!publicId.success) return notFound();
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        const usageCursor = new URL(request.url).searchParams.get(
          "usageCursor",
        );
        try {
          const run = await loadImportRunByPublicId(
            context.db,
            context.actorContext,
            publicId.data,
            usageCursor ? { usageCursor } : undefined,
          );
          return Response.json(
            purchaseImportRunDetailResponse.parse({ run: browserRun(run) }),
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "Purchase import run was not found"
          )
            return notFound();
          throw error;
        }
      },
      PATCH: async ({ params, request }) => {
        const publicId = importRunPublicId.safeParse(params.publicId);
        const input = purchaseImportRunControlInput.safeParse(
          await request.json(),
        );
        if (!publicId.success || !input.success) return notFound();
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        try {
          const control = await controlImportRun(
            context.db,
            context.actorContext,
            {
              runPublicId: publicId.data,
              ...input.data,
            },
          );
          if (
            "successorRunId" in control &&
            control.successorRunId &&
            control.successorRunPublicId
          ) {
            const queue = getPurchaseAgentQueue();
            if (!queue)
              throw new Error("Purchase import agent queue is unavailable");
            await queue.send({
              version: 1,
              runId: control.successorRunId,
              publicId: control.successorRunPublicId,
              coordinatorModel:
                input.data.action === "escalate_sol"
                  ? "gpt-5.6-sol"
                  : "gpt-5.6-terra",
              eventId: crypto.randomUUID(),
              type: "start_or_resume",
            });
          }
          const run = await loadImportRunByPublicId(
            context.db,
            context.actorContext,
            publicId.data,
          );
          return Response.json(
            purchaseImportRunControlResponse.parse({
              run: browserRun(run),
              successor:
                "successorRunPublicId" in control &&
                control.successorRunPublicId
                  ? {
                      publicId: control.successorRunPublicId,
                      status: control.successorStatus,
                      created: control.created,
                    }
                  : null,
            }),
          );
        } catch (error) {
          if (
            error instanceof Error &&
            (error.message === "Import run was not found" ||
              error.message === "Purchase import run was not found")
          )
            return notFound();
          return Response.json(
            purchaseImportRunDetailError.parse({
              error: "This import run could not be updated.",
            }),
            { status: 409 },
          );
        }
      },
    },
  },
});
