import { importRunPurpose } from "@cubby/schemas/purchase-import";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
  importRunShortcode,
  importRunControlInput,
  importRunControlResponse,
  importRunDetailError,
  importRunDetailResponse,
} from "~/lib/purchase-import-run-detail";
import { getPurchaseAgentQueue } from "~/server/cf-env";
import { recordImportRunDispatchAttempt } from "~/server/purchase-import/dispatch";
import {
  controlImportRun,
  loadImportRunByShortcode,
} from "~/server/purchase-import/run-service";
import { createRequestContext, requireActor } from "~/server/request-context";

const notFound = () =>
  Response.json({ error: "Import run was not found" }, { status: 404 });

const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Strip internal ids and operation payloads before the browser receives a run. */
const browserRun = (
  run: Awaited<ReturnType<typeof loadImportRunByShortcode>>,
) => ({
  publicId: run.publicId,
  status: run.status,
  purpose: run.purpose,
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
  notes: run.notes,
  dispatch: {
    eventId: run.dispatch.eventId,
    state: run.dispatch.coordinatorStartedAt
      ? "started"
      : run.dispatch.error
        ? "failed"
        : "pending",
    attempts: run.dispatch.attempts,
    error: run.dispatch.error,
    coordinatorStartedAt: iso(run.dispatch.coordinatorStartedAt),
  },
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
  targets: run.targets.map((target) => ({
    id: target.id,
    // A photo-inventory run's targets are always images — it never creates a
    // purchase or product target row, so the run's purpose alone disambiguates.
    targetType: target.purchaseId
      ? "purchase"
      : run.purpose === "photo_inventory"
        ? "image"
        : "product",
    targetShortcode: target.purchaseId ?? target.productId,
    targetName: null,
    sourceId: null,
    sourceLabel: target.sourceKind
      ? `${target.sourceKind}${target.sourceExternalKey ? ` · ${target.sourceExternalKey}` : ""}`
      : null,
    vendorAccountLabel: target.vendorAccountId,
    state: target.state,
    fingerprint: target.targetFingerprint,
    outcome: target.outcome,
    warning: target.warning,
    diff: target.diff,
    completedAt: iso(target.completedAt),
  })),
  evidence: run.evidence.map((evidence) => ({
    id: evidence.id,
    // Run-target UUIDs are internal. Evidence still renders under the run.
    targetId: null,
    sourceKind: evidence.kind,
    filename: null,
    mediaType: evidence.mediaType,
    checksum: evidence.checksum,
    createdAt: evidence.createdAt.toISOString(),
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
        const publicId = importRunShortcode.safeParse(params.publicId);
        if (!publicId.success) return notFound();
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        const usageCursor = new URL(request.url).searchParams.get(
          "usageCursor",
        );
        try {
          const run = await loadImportRunByShortcode(
            context.db,
            context.actorContext,
            publicId.data,
            usageCursor ? { usageCursor } : undefined,
          );
          return Response.json(
            importRunDetailResponse.parse({ run: browserRun(run) }),
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
        const publicId = importRunShortcode.safeParse(params.publicId);
        const input = importRunControlInput.safeParse(await request.json());
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
            "dispatchRunId" in control &&
            control.dispatchRunId &&
            control.dispatchEventId
          ) {
            const queue = getPurchaseAgentQueue();
            if (!queue) {
              await recordImportRunDispatchAttempt(context.db, {
                runId: control.dispatchRunId,
                eventId: control.dispatchEventId,
                error: "Purchase import agent queue is unavailable",
              });
            } else {
              try {
                await queue.send({
                  version: 1,
                  runId: control.dispatchRunId,
                  purpose: importRunPurpose.parse(control.dispatchPurpose),
                  coordinatorModel: z
                    .enum(["gpt-5.6-terra", "gpt-5.6-sol"])
                    .parse(control.dispatchCoordinatorModel),
                  eventId: control.dispatchEventId,
                  type: "start_or_resume",
                });
                await recordImportRunDispatchAttempt(context.db, {
                  runId: control.dispatchRunId,
                  eventId: control.dispatchEventId,
                });
              } catch (error) {
                await recordImportRunDispatchAttempt(context.db, {
                  runId: control.dispatchRunId,
                  eventId: control.dispatchEventId,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Queue send failed",
                });
              }
            }
          }
          const run = await loadImportRunByShortcode(
            context.db,
            context.actorContext,
            publicId.data,
          );
          return Response.json(
            importRunControlResponse.parse({
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
            importRunDetailError.parse({
              error: "This import run could not be updated.",
            }),
            { status: 409 },
          );
        }
      },
    },
  },
});
