import type { RunId } from "@cubby/schemas/identifiers";
import type { RunTrigger } from "@cubby/schemas/purchase-import";
import type { RunCause, RunPurpose } from "@cubby/schemas/run-fields";
import type { RunWorkItems } from "@cubby/schemas/run-work-progress";
import { asc, eq, isNotNull, isNull } from "drizzle-orm";

import { getDb } from "~/server/db/helpers";
import { email as emailTable } from "~/server/db/retained-tables";
import { drizzleSchema as schema } from "~/server/db/drizzle-schema";
import { updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { sampleRunWork } from "~/server/domains/run/repo/work-progress";

import type { KernelContext } from "./context";

/** Synthetic Job kind: no handler, so only the fixture's own rows exist. */
const QUEUE_KIND = "fixture.run-queue";
const MINUTE = 60_000;

type SeededRun = {
  purpose: RunPurpose;
  trigger: RunTrigger;
  cause: RunCause;
  parent?: RunId;
  status: "running" | "paused" | "needs_review" | "completed" | "failed";
  startedMinutesAgo: number;
  endedMinutesAgo?: number;
  work?: Omit<RunWorkItems, "phase" | "failures"> & { failures?: number };
  input?: unknown;
  vendor?: boolean;
  failure?: { code: string; detail: string };
};

/**
 * Runs in every state the list draws: an inbox scan with an unknown total
 * whose Email imports fold into a batch (running, queued in claim order,
 * completed) beside one that needs review, a member's import whose Sweeps
 * batch beside a stalled and a needs-review Sweep, a long failure, a paused
 * Sweep, recent and older finished Runs, and progress at 12 units or fewer,
 * more, and unknown. Nothing dispatches: execution is off and the queued
 * Jobs are a handler-less kind.
 */
export async function seedRunPatterns(context: KernelContext): Promise<void> {
  const { db, actorContext } = context;
  const database = getDb(db);
  const now = Date.now();
  const [vendor] = await database
    .select({ id: schema.vendor.id })
    .from(schema.vendor)
    .where(isNull(schema.vendor.deletedAt))
    .orderBy(asc(schema.vendor.name))
    .limit(1);

  const [source] = await database
    .select({
      orderMailId: emailTable.orderMailId,
      checksum: emailTable.checksum,
    })
    .from(emailTable)
    .where(isNotNull(emailTable.orderMailId))
    .orderBy(asc(emailTable.orderMailId))
    .limit(1);
  const roster = source?.orderMailId
    ? {
        kind: "mail_research",
        sources: [
          { orderMailId: source.orderMailId, checksum: source.checksum },
        ],
      }
    : null;

  const seed = async (run: SeededRun): Promise<RunId> => {
    const id = await ensureRun(db, actorContext, {
      purpose: run.purpose,
      trigger: run.trigger,
      cause: run.cause,
      execution: false,
      ...(run.parent ? { parentRunId: run.parent } : {}),
      // SAFETY: each fixture input matches its purpose's stored shape.
      ...(run.input ? { input: run.input as never } : {}),
      // A live Mail import always holds a roster that names a retained
      // Email; run.control and the Run detail read it back.
      // SAFETY: the roster is the mail_research shape built above.
      ...(run.purpose === "mail_import" && !run.input && roster
        ? { input: roster as never }
        : {}),
    });
    const startedAt = new Date(now - run.startedMinutesAgo * MINUTE);
    const endedAt =
      run.endedMinutesAgo === undefined
        ? null
        : new Date(now - run.endedMinutesAgo * MINUTE);
    const work = run.work
      ? sampleRunWork(
          undefined,
          { phase: "fixture", failures: 0, ...run.work },
          {
            startedAt,
            sampledAt: endedAt ?? new Date(now),
            finished: endedAt !== null,
          },
        )
      : undefined;
    await database
      .update(schema.run)
      .set({
        status: run.status,
        startedAt,
        endedAt,
        vendorId: run.vendor && vendor ? vendor.id : null,
        failureCode: run.failure?.code ?? null,
        dispatchError: run.failure?.detail ?? null,
        ...(work
          ? {
              liveProgress: {
                generation: "fixture",
                sequence: 1,
                eventId: `fixture-${id}`,
                phase: "fixture",
                currentItem: null,
                awaitingApproval: false,
                detail: null,
                createdAt: (endedAt ?? new Date(now)).toISOString(),
                work,
              },
            }
          : {}),
      })
      .where(eq(schema.run.id, id));
    return id;
  };

  // A waiting Job places the Run in its kind's claim order; a live lease on
  // a second Job keeps a queued Run from reading as stalled.
  const queue = async (runId: RunId, position: number) => {
    const waiting = await enqueueJob(db, {
      key: `${QUEUE_KIND}:${runId}:waiting`,
      kind: QUEUE_KIND,
      input: {},
      runId,
    });
    await updateJobs(
      db,
      { id: waiting.id },
      { availableAt: new Date(now - (30 - position) * MINUTE) },
    );
    const leased = await enqueueJob(db, {
      key: `${QUEUE_KIND}:${runId}:leased`,
      kind: QUEUE_KIND,
      input: {},
      runId,
    });
    await updateJobs(
      db,
      { id: leased.id },
      {
        state: "running",
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(now + 365 * 24 * 60 * MINUTE),
        lastClaimedAt: new Date(now),
      },
    );
  };

  const scan = await seed({
    purpose: "mail_discovery",
    trigger: "scheduled",
    cause: "scheduled",
    status: "running",
    startedMinutesAgo: 25,
    input: {
      mailboxId: "sam@example.test",
      scopedQueries: [],
      executionPolicy: "import",
    },
    work: {
      label: "Reading messages",
      unit: "messages",
      processed: 428,
      total: null,
    },
  });
  const found = {
    purpose: "mail_import",
    trigger: "discovery",
    cause: "source_discovered",
    parent: scan,
    vendor: true,
  } as const;
  await seed({
    ...found,
    status: "running",
    startedMinutesAgo: 12,
    work: {
      label: "Booking expense lines",
      unit: "emails",
      processed: 2,
      total: 3,
    },
  });
  for (const position of [1, 2, 3]) {
    const queued = await seed({
      ...found,
      status: "running",
      startedMinutesAgo: 10 - position,
      work: {
        label: "Waiting to start",
        unit: "emails",
        processed: 0,
        total: position,
      },
    });
    await queue(queued, position);
  }
  // Recent completions pace the kind, so the queued Runs carry an estimate.
  for (const index of [0, 1]) {
    const done = await enqueueJob(db, {
      key: `${QUEUE_KIND}:${scan}:done-${index}`,
      kind: QUEUE_KIND,
      input: {},
      runId: scan,
    });
    await updateJobs(
      db,
      { id: done.id },
      { state: "completed", updatedAt: new Date(now) },
    );
  }
  await seed({
    ...found,
    status: "completed",
    startedMinutesAgo: 9,
    endedMinutesAgo: 4,
    work: { label: "Imported", unit: "emails", processed: 1, total: 1 },
  });
  await seed({
    ...found,
    status: "needs_review",
    startedMinutesAgo: 20,
    endedMinutesAgo: 13,
    work: {
      label: "Three possible duplicates",
      unit: "emails",
      processed: 3,
      total: 3,
    },
  });

  const imported = await seed({
    purpose: "mail_import",
    trigger: "manual",
    cause: "member_request",
    vendor: true,
    status: "running",
    startedMinutesAgo: 30,
    work: {
      label: "Waiting on its Sweeps",
      unit: "emails",
      processed: 2,
      total: 2,
    },
  });
  const after = {
    purpose: "sweep",
    trigger: "scheduled",
    cause: "import_completed",
    parent: imported,
  } as const;
  await seed({
    ...after,
    status: "running",
    startedMinutesAgo: 8,
    work: {
      label: "Suggesting categories",
      unit: "expenses",
      processed: 3,
      total: 8,
    },
  });
  await seed({
    ...after,
    status: "running",
    startedMinutesAgo: 6,
    work: {
      label: "Suggesting brands",
      unit: "products",
      processed: 88,
      total: 230,
    },
  });
  await seed({
    ...after,
    status: "completed",
    startedMinutesAgo: 7,
    endedMinutesAgo: 2,
    work: { label: "Suggested", unit: "products", processed: 12, total: 12 },
  });
  await seed({
    ...after,
    status: "needs_review",
    startedMinutesAgo: 14,
    endedMinutesAgo: 13,
    work: {
      label: "One step failed",
      unit: "expenses",
      processed: 4,
      total: 4,
      failures: 1,
    },
  });
  // Stalled: a live Job nobody claimed for longer than the stall window.
  const stalled = await seed({
    ...after,
    status: "running",
    startedMinutesAgo: 40,
    work: {
      label: "Suggesting units",
      unit: "products",
      processed: 5,
      total: 9,
    },
  });
  await enqueueJob(db, {
    key: `${QUEUE_KIND}:${stalled}:stalled`,
    kind: QUEUE_KIND,
    input: {},
    runId: stalled,
  });

  await seed({
    purpose: "mail_import",
    trigger: "manual",
    cause: "member_request",
    vendor: true,
    status: "failed",
    startedMinutesAgo: 130,
    endedMinutesAgo: 120,
    work: {
      label: "Reading the order",
      unit: "emails",
      processed: 0,
      total: 1,
      failures: 1,
    },
    failure: {
      code: "agent_failed",
      detail:
        "The import agent stopped before it finished reading the order: the synthetic vendor page returned an unexpected layout twice, so no expense lines were booked and the retained email is unchanged.",
    },
  });
  await seed({
    purpose: "sweep",
    trigger: "manual",
    cause: "member_request",
    status: "paused",
    startedMinutesAgo: 50,
    work: { label: "Paused", unit: "products", processed: 40, total: 120 },
  });
  await seed({
    purpose: "mail_import",
    trigger: "manual",
    cause: "member_request",
    vendor: true,
    status: "completed",
    startedMinutesAgo: 64,
    endedMinutesAgo: 60,
    work: { label: "Imported", unit: "emails", processed: 2, total: 2 },
  });
  await seed({
    purpose: "sweep",
    trigger: "scheduled",
    cause: "scheduled",
    status: "completed",
    startedMinutesAgo: 245,
    endedMinutesAgo: 240,
    work: { label: "Suggested", unit: "products", processed: 12, total: 12 },
  });
  // Older than the Recently finished window: Show older reveals it.
  await seed({
    purpose: "mail_import",
    trigger: "manual",
    cause: "member_request",
    vendor: true,
    status: "completed",
    startedMinutesAgo: 10 * 24 * 60 + 5,
    endedMinutesAgo: 10 * 24 * 60,
    work: { label: "Imported", unit: "emails", processed: 1, total: 1 },
  });
}
