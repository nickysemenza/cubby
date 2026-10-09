import { runShortcode } from "@cubby/schemas/identifiers";
import {
  chargeHuntOutcomeOf,
  mailDiscoveryRunProgress,
  orderMailImportRunInput,
  runOrderCandidateState,
  runStatus,
} from "@cubby/schemas/run-fields";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  financialTransaction,
  importHunt,
  run,
  runOrderCandidate,
  runProgress,
} from "~/server/db/schema";
import { researchChargeHuntIds } from "~/server/purchase-import/research-objective";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  isWorkflowRunPurpose,
  workflowInstanceId,
} from "~/server/workflow-runs/contract";
import {
  productionWorkflowLauncher,
  type WorkflowInstanceStatus,
  type WorkflowLauncher,
} from "~/server/workflow-runs/launcher";

/**
 * Cloudflare's view of the Run's current attempt, or null when it cannot be
 * read (no binding outside the Worker, an API error). Diagnostics only: the
 * Run row stays the record, and a missing instance is reported as such.
 */
async function instanceStatus(
  launcher: WorkflowLauncher,
  purpose: Parameters<WorkflowLauncher["status"]>[0],
  id: string,
): Promise<WorkflowInstanceStatus | null> {
  try {
    return await launcher.status(purpose, id);
  } catch {
    // SILENT: an unreadable instance only drops the optional diagnostic line.
    return null;
  }
}

/** The Workflow attempt behind a Gmail Run, with Cloudflare's view of it. */
async function workflowAttempt(
  launcher: WorkflowLauncher,
  run: { purpose: string; shortcode: string },
  attempt: number,
) {
  if (!isWorkflowRunPurpose(run.purpose) || attempt === 0) return null;
  const instanceId = workflowInstanceId(run.shortcode, attempt);
  return {
    purpose: run.purpose,
    attempt,
    instanceId,
    instance: await instanceStatus(launcher, run.purpose, instanceId),
  };
}

/** The small, durable progress read shared by every Run detail page. */
export async function getRunLiveProgress(
  db: Database,
  shortcode: string,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
) {
  const database = getDb(db);
  const [record] = await database
    .select({ run })
    .from(run)
    .where(
      and(eq(run.shortcode, runShortcode.parse(shortcode)), notDeleted(run)),
    )
    .limit(1);
  if (!record) return null;
  const discovery =
    record.run.purpose === "mail_discovery"
      ? mailDiscoveryRunProgress.safeParse(record.run.progress).data
      : undefined;
  const workflow = await workflowAttempt(
    launcher,
    record.run,
    discovery?.attempt ?? 0,
  );
  const events = await database
    .select({
      id: runProgress.eventId,
      phase: runProgress.phase,
      detail: runProgress.detail,
      createdAt: runProgress.createdAt,
      ageSeconds: sql<number>`greatest(0, floor(extract(epoch from (now()::timestamp - ${runProgress.createdAt}))))::int`,
    })
    .from(runProgress)
    .where(eq(runProgress.runId, record.run.id))
    .orderBy(desc(runProgress.createdAt), desc(runProgress.id))
    .limit(100);
  const selected = orderMailImportRunInput.safeParse(record.run.input);
  const orders =
    selected.success && "orders" in selected.data
      ? await database
          .select({
            orderId: runOrderCandidate.orderId,
            state: runOrderCandidate.state,
          })
          .from(runOrderCandidate)
          .where(eq(runOrderCandidate.runId, record.run.id))
          .orderBy(
            asc(runOrderCandidate.orderedAt),
            asc(runOrderCandidate.orderId),
          )
      : [];
  const huntIds = researchChargeHuntIds(record.run.input);
  const charges = huntIds?.length
    ? await database
        .select({
          chargeId: financialTransaction.shortcode,
          state: importHunt.state,
        })
        .from(importHunt)
        .innerJoin(
          financialTransaction,
          and(
            eq(financialTransaction.id, importHunt.financialTransactionId),
            notDeleted(financialTransaction),
          ),
        )
        .where(inArray(importHunt.id, huntIds))
        .orderBy(
          asc(financialTransaction.transactionDate),
          asc(financialTransaction.shortcode),
        )
    : [];
  return {
    status: runStatus.parse(record.run.status),
    charges: charges.map((charge) => ({
      chargeId: charge.chargeId,
      outcome: chargeHuntOutcomeOf(charge.state),
    })),
    orders: orders.map((order) => ({
      orderId: order.orderId,
      state: runOrderCandidateState.parse(order.state),
    })),
    progress: events.reverse().map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    })),
    discovery: discovery
      ? {
          pagesDone: discovery.pagesDone,
          saved: discovery.saved,
          deleted: discovery.deleted,
          excluded: discovery.excluded,
          unrelated: discovery.unrelated,
          events: discovery.events,
          droppedEvents: discovery.droppedEvents,
          routine: record.run.routine,
        }
      : null,
    workflow,
  };
}
