import { AsyncLocalStorage } from "node:async_hooks";

import {
  backgroundTaskSchema,
  type BackgroundTaskInput,
  type BackgroundTaskReceipt,
} from "@cubby/schemas/background-tasks";
import { BACKGROUND_TASK_MESSAGE_VERSION } from "@cubby/schemas/queue-messages";
import { retryWithBackoff } from "@cubby/shared/retry";
import { createLogger } from "@cubby/worker-tracing";
import { sql } from "drizzle-orm";

import { afterResponse, getBackgroundQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { runAfterCommit } from "~/server/db/helpers/core";
import {
  repositoryAfterCommit,
  repositoryQueries,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { isoText } from "~/server/kernel/sql-time";

import type { BackgroundQueueProducer } from "../background-queue-types";

const logger = createLogger("jobs");

/** The earliest future wake requested while a delivery runs. */
type DeliveryWakes = { future: Date | null };
const deliveryWakes = new AsyncLocalStorage<DeliveryWakes>();

/**
 * Run a delivery's work. Its immediate wakes are dropped: the runner drains
 * until an empty round, and the delivery itself continues when its budget
 * ends with work due. Its future wakes join the delivery's one offer.
 */
export async function collectDeliveryWakes<T>(
  work: () => Promise<T>,
): Promise<{ result: T; future: Date | null }> {
  const wakes: DeliveryWakes = { future: null };
  const result = await deliveryWakes.run(wakes, work);
  return { result, future: wakes.future };
}

/** Inside a delivery, redelivery of the unacknowledged permit recovers a crash. */
export const withinDelivery = (): boolean =>
  deliveryWakes.getStore() !== undefined;

export interface PublishOptions {
  readonly source: string;
}

type WakeMessage =
  Parameters<BackgroundQueueProducer["sendBatch"]>[0] extends Iterable<infer M>
    ? M
    : never;

/**
 * Waits between producer attempts. A member's Run can have no other wake, so a transient
 * send failure is retried here and not left for the next hourly tick. The queue's own
 * `maxRetries` cannot help, because a failed send never enqueued anything. The total fits
 * the 30 seconds `waitUntil` allows after a response.
 */
const WAKE_RETRY_DELAYS_MS = [250, 1_000, 4_000];

/** Send a wake, retrying a failed send. Exhaustion leaves the work to the hourly cron. */
async function sendWake(
  queue: BackgroundQueueProducer,
  message: () => WakeMessage,
  log: { source: string; exhausted: string },
  onExhausted?: () => Promise<void>,
) {
  try {
    await retryWithBackoff(() => queue.sendBatch([message()]), {
      delayFor: (outcome, attempt) =>
        outcome.ok ? null : (WAKE_RETRY_DELAYS_MS[attempt] ?? null),
    });
  } catch (error) {
    logger.error(log.exhausted, { source: log.source, error });
    await onExhausted?.().catch((reset: unknown) =>
      logger.error("pending wake reset failed", {
        source: log.source,
        error: reset,
      }),
    );
  }
}

/** Best-effort permit for intent already committed in Postgres. */
export async function wakeKernel(
  options: PublishOptions & { queue?: BackgroundQueueProducer },
) {
  if (withinDelivery()) return;
  const queue = options.queue ?? getBackgroundQueue();
  if (!queue) return;
  // Only the wake is deferred: callers commit durable intent before getting here.
  // Queue and cron invocations have no request lifetime and still await the send.
  await afterResponse(
    sendWake(
      queue,
      () => ({
        body: {
          version: BACKGROUND_TASK_MESSAGE_VERSION,
          queueType: "background",
        },
      }),
      {
        source: options.source,
        exhausted: "wake failed; the hourly cron will drain committed work",
      },
    ),
  );
}

/** Cloudflare Queues' longest delivery delay; anything later waits for the hourly cron. */
const MAX_WAKE_DELAY_SECONDS = 12 * 3_600;
const delaySecondsUntil = (at: Date) =>
  Math.max(0, Math.ceil((at.getTime() - Date.now()) / 1000));

/**
 * A best-effort wake when known work falls due. Inside a delivery a future
 * `at` joins the delivery's offer and a due one is dropped. Otherwise nothing
 * is decided or sent until the caller's transaction on `db` (default: the
 * invocation database) commits: a consumer must not drain before the rows it
 * wakes for are visible, and a rollback must send nothing. Then a due `at` is
 * an immediate wake and a future one is offered (`offerWake`). `ring` also
 * rings companions for parked device work (`ringDueDeviceWork`): a ring permit
 * is always sent, so it never merges into a wake without it, and its callers
 * send it after their commit.
 */
export async function wakeAt(
  at: Date,
  options: PublishOptions & { ring?: boolean; db?: Database },
) {
  if (options.ring) return sendRing(at, options.source);
  const delivery = deliveryWakes.getStore();
  if (delivery) {
    if (at.getTime() > Date.now() && (!delivery.future || at < delivery.future))
      delivery.future = at;
    return;
  }
  const db = options.db ?? (await import("~/server/db")).db;
  await repositoryAfterCommit(db, (committed) =>
    at.getTime() <= Date.now()
      ? wakeKernel({ source: options.source })
      : offerWake(committed, at, options.source),
  );
}

async function sendRing(at: Date, source: string) {
  if (delaySecondsUntil(at) > MAX_WAKE_DELAY_SECONDS) return;
  const queue = getBackgroundQueue();
  if (!queue) return;
  await afterResponse(
    sendWake(
      queue,
      () => ({
        body: {
          version: BACKGROUND_TASK_MESSAGE_VERSION,
          queueType: "background",
          ring: true,
        },
        // A retry still lands when the work is due.
        delaySeconds: delaySecondsUntil(at),
      }),
      {
        source,
        exhausted: "device ring wake failed; the hourly cron will ring",
      },
    ),
  );
}

/**
 * Exactly one future wake is pending (ADR 0029 section 7). An offer for T
 * sends a delayed permit carrying T only when it moves `KernelWake.at` to T,
 * which it may when the row is empty, already due, or later than T. Every
 * other offer is covered by the pending wake, whose delivery clears the row
 * while it still holds that permit's `at` (`clearDeliveredWakes`) and offers
 * the global next deadline. Stale and duplicate permits therefore end without
 * a successor. The statement runs alone after the caller's commit, so it never
 * holds the row inside a gated transaction.
 *
 * Offers refused while a permit is pending are not remembered: their deadlines
 * rely on that permit's delivery offering the global next deadline. So a lost
 * permit leaves them waiting until its `at` passes and another offer wins, or
 * the hourly cron; a send that exhausts its retries empties the row so a later
 * offer can win, but the deadlines it refused meanwhile wait the same way.
 * Deadline writers that send no wake of their own are bounded the same way:
 * settlements, backoffs and waits written inside a delivery (its offer covers
 * them) and backoffs settled by an in-line producer call outside one.
 */
export async function offerWake(
  db: Database,
  at: Date,
  source: string,
): Promise<void> {
  if (delaySecondsUntil(at) > MAX_WAKE_DELAY_SECONDS) return;
  const queue = getBackgroundQueue();
  if (!queue) return;
  await afterResponse(
    (async () => {
      let pending: string | undefined;
      try {
        const won = await repositoryQueries(db).execute<{ at: string }>(sql`
          INSERT INTO "KernelWake" (at) VALUES (${at.toISOString()}::timestamp)
          ON CONFLICT (singleton) DO UPDATE SET at = excluded.at
          WHERE "KernelWake".at IS NULL OR "KernelWake".at <= now() OR "KernelWake".at > excluded.at
          RETURNING ${isoText(sql`"KernelWake".at`)} AS at`);
        pending = won.rows[0]?.at;
        if (!pending) return;
      } catch (error) {
        // The wake is still owed; without the row it only cannot be deduplicated.
        logger.error("wake offer failed; sending unrecorded", {
          source,
          error,
        });
      }
      await sendWake(
        queue,
        () => ({
          body: {
            version: BACKGROUND_TASK_MESSAGE_VERSION,
            queueType: "background",
            ...(pending ? { at: pending } : {}),
          },
          // A retry still lands when the work is due.
          delaySeconds: delaySecondsUntil(at),
        }),
        {
          source,
          exhausted:
            "delayed wake failed; the hourly cron will reach this work",
        },
        // Nothing carries this `at`, so a later offer must be able to win.
        pending ? () => clearDeliveredWakes(db, [pending]) : undefined,
      );
    })(),
  );
}

/** Empty the pending wake when it is the one these permits carried. */
export async function clearDeliveredWakes(
  db: Database,
  delivered: readonly string[],
): Promise<void> {
  if (!delivered.length) return;
  await repositoryQueries(db).execute(sql`
    UPDATE "KernelWake" SET at = NULL
    WHERE at = ANY(${textArrayParam(delivered)}::timestamp[])`);
}

/** Persist using the caller's transaction; the transport carries only a wake. */
export async function publishBackgroundTasks(
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
): Promise<BackgroundTaskReceipt> {
  if (!tasks.length) return { count: 0 };
  await repositoryTransactionDatabase(db, async (tx) => {
    const parsed = tasks.map((input) => backgroundTaskSchema.parse(input));
    const embeddingTasks = [
      ...new Map(
        parsed
          .filter((task) => task.kind === "entity-embedding.refresh")
          .map((task) => [`${task.entityKind}:${task.entityId}`, task]),
      ).values(),
    ];
    if (embeddingTasks.length) {
      const { enqueueEmbeddingRefs } = await import("./embedding");
      const { prepareSearchDocuments, publishPreparedSearchDocuments } =
        await import("~/server/generic/search/repo/search-document");
      for (let offset = 0; offset < embeddingTasks.length; offset += 200) {
        const prepared = await prepareSearchDocuments(
          tx,
          embeddingTasks.slice(offset, offset + 200),
        );
        await publishPreparedSearchDocuments(tx, prepared);
        await enqueueEmbeddingRefs(tx, prepared);
      }
    }
    for (const task of parsed) {
      if (task.kind === "entity-embedding.refresh") continue;
      if (task.kind === "maintenance.purchase-discovery") {
        const { mailboxDiscoveryPass, purchaseDiscoveryPass } =
          await import("../purchase-discovery-pass");
        const { startPass } = await import("~/server/kernel/api");
        await startPass(tx, purchaseDiscoveryPass);
        await startPass(tx, mailboxDiscoveryPass);
        continue;
      }
      if (task.kind === "calendar-feed.mark-dirty") {
        const { calendarInvalidatePass } =
          await import("../calendar-invalidate-pass");
        const { startPass } = await import("~/server/kernel/api");
        await startPass(tx, calendarInvalidatePass, {
          key: task.origin,
          cursor: { origin: task.origin, reason: task.reason },
        });
        continue;
      }
      const { startPass } = await import("~/server/kernel/api");
      await startPass(tx, "location.inventory", {
        key: task.locationId,
        runId: task.runId,
        cursor: {
          locationId: task.locationId,
          ...(task.runId ? { runId: task.runId } : {}),
        },
      });
    }
    if (
      parsed.some(
        (task) =>
          task.kind !== "maintenance.purchase-discovery" &&
          task.kind !== "calendar-feed.mark-dirty",
      )
    )
      await runAfterCommit(tx, () => wakeKernel(options));
  });
  return { count: tasks.length };
}

export async function enqueueBackgroundTask(
  task: BackgroundTaskInput,
  options: PublishOptions & { queue?: BackgroundQueueProducer },
): Promise<boolean> {
  const { db } = await import("~/server/db");
  await publishBackgroundTasks(db, [task], options);
  return true;
}

export async function publishInBackground(
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
): Promise<void> {
  await publishBackgroundTasks(db, tasks, options);
}

export type BackgroundTaskPublisher = (
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
) => Promise<BackgroundTaskReceipt | void>;
