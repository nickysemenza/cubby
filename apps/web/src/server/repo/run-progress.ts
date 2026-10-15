import { runEntityId, runShortcode } from "@cubby/schemas/identifiers";
import type { AgentProgressEvent } from "@cubby/schemas/purchase-agent-services";
import {
  mailDiscoveryRunProgress,
  runProgressEvent,
  runStatus,
  type RunProgressEvent,
} from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { run } from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers/core";
import { notDeleted } from "~/server/repo/database-helpers/query";
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
  const workflowProgress = z
    .object({ attempt: z.number() })
    .safeParse(record.run.progress);
  const workflow = await workflowAttempt(
    launcher,
    record.run,
    workflowProgress.success ? workflowProgress.data.attempt : 0,
  );
  const events = record.run.progressHistory ?? [];
  return {
    status: runStatus.parse(record.run.status),
    progress: events.map((event) => ({
      id: event.eventId,
      phase: event.phase,
      detail: event.detail,
      createdAt: event.createdAt,
      ageSeconds: Math.max(
        0,
        Math.floor((Date.now() - Date.parse(event.createdAt)) / 1000),
      ),
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

/** Run row locking makes deduplication, delivery fencing and heartbeat one write. */
export async function recordRunProgress(
  db: Database,
  input: AgentProgressEvent,
  now = new Date(),
): Promise<{ recorded: boolean }> {
  const id = runEntityId.parse(input.runId);
  return withTransaction(db, async (tx) => {
    const [current] = await tx
      .select()
      .from(run)
      .where(eq(run.id, id))
      .for("no key update");
    if (!current) throw new Error("Progress Run does not exist");
    const eventIds = current.progressEventIds ?? [];
    if (eventIds.includes(input.eventId)) return { recorded: false };
    const workflow = z
      .object({ attempt: z.number() })
      .safeParse(current.progress);
    const generation =
      current.dispatchEventId ??
      (workflow.success ? `workflow:${workflow.data.attempt}` : null);
    if (generation !== input.generation) return { recorded: false };
    if (
      current.liveProgress?.generation === input.generation &&
      current.liveProgress.sequence >= input.sequence
    )
      return { recorded: false };
    const event: RunProgressEvent = runProgressEvent.parse({
      ...input,
      currentItem: input.currentItem ?? null,
      awaitingApproval: input.awaitingApproval ?? false,
      detail: input.detail ?? null,
      createdAt: now.toISOString(),
    });
    await tx
      .update(run)
      .set({
        liveProgress: event,
        progressHistory: [...(current.progressHistory ?? []), event].slice(
          -100,
        ),
        progressEventIds: [...eventIds, input.eventId],
        heartbeatAt: now,
      })
      .where(eq(run.id, id));
    return { recorded: true };
  });
}
