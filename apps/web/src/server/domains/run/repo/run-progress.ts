import { runEntityId, runShortcode } from "@cubby/schemas/identifiers";
import type { AgentProgressEvent } from "@cubby/schemas/purchase-agent-services";
import {
  mailDiscoveryRunProgress,
  runProgressEvent,
  runStatus,
  type RunProgressEvent,
  isStepRunPurpose,
} from "@cubby/schemas/run-fields";
import { runWorkSamples } from "@cubby/schemas/run-work-progress";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers/core";
import { notDeleted } from "~/server/db/helpers/predicates";
import { run } from "~/server/db/schema";
import { recordChange } from "~/server/generic/changes/repo/change";
import { currentJobExecution } from "~/server/generic/jobs/context";
import { readJob } from "~/server/generic/jobs/repo/job-reads";
import { assertWorkflowEffect } from "~/server/workflows/runs/execution";

/** The small, durable progress read shared by every Run detail page. */
export async function getRunLiveProgress(db: Database, shortcode: string) {
  const database = getDb(db);
  const [record] = await database
    .select({
      run: {
        id: run.id,
        status: run.status,
        purpose: run.purpose,
        shortcode: run.shortcode,
        progress: run.progress,
        progressHistory: run.progressHistory,
        routine: run.routine,
      },
    })
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
  const execution = await readJob(db, { key: `run:${record.run.id}` });
  const workflow = execution
    ? {
        purpose: record.run.purpose,
        attempt: execution.generation,
        instanceId: execution.id,
        instance: { state: execution.state, error: execution.error },
      }
    : null;
  const events = record.run.progressHistory ?? [];
  return {
    status: runStatus.parse(record.run.status),
    workProgress: await (
      await import("./work-progress")
    ).getRunWorkProgress(db, shortcode),
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
  return withTransactionDatabase(db, async (database) => {
    const owner = currentJobExecution();
    await assertWorkflowEffect(database);
    const tx = getDb(database);
    const [current] = await tx
      .select()
      .from(run)
      .where(eq(run.id, id))
      .for("no key update");
    if (!current) throw new Error("Progress Run does not exist");
    const eventIds = current.progressEventIds ?? [];
    if (eventIds.includes(input.eventId)) return { recorded: false };
    const execution = current.dispatchEventId
      ? null
      : await readJob(database, { key: `run:${id}` });
    const generation =
      current.dispatchEventId ??
      (execution && owner?.claim.id === execution.id
        ? `job:${execution.generation}`
        : null);
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
    const work = isStepRunPurpose(current.purpose)
      ? null
      : await (
          await import("./work-progress")
        ).getRunWorkProgress(database, current.shortcode, now);
    await tx
      .update(run)
      .set({
        liveProgress: {
          ...event,
          ...(work && { work: runWorkSamples.parse(work) }),
        },
        progressHistory: [...(current.progressHistory ?? []), event].slice(
          -100,
        ),
        progressEventIds: [...eventIds, input.eventId],
        heartbeatAt: now,
      })
      .where(eq(run.id, id));
    await recordChange(database, { kind: "projection", categories: ["run"] });
    return { recorded: true };
  });
}
