import { createLogger } from "@cubby/worker-tracing";

import { afterResponse } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  publishWorkItems,
  readWorkPublication,
  workPublicationStale,
} from "~/server/generic/work-queue/repo/work-publication";
import {
  insertWorkItems,
  readRecordWorkQueueWith,
  readWorkQueueWith,
} from "~/server/generic/work-queue/repo/work-queue";

import { workQueueComposition } from "./work-queue-composition";

/** The household or member queue over every composed work source. */
export const readWorkQueue = async (
  db: Database,
  read: Parameters<typeof readWorkQueueWith>[2],
) => readWorkQueueWith(db, await workQueueComposition(), read);

const log = createLogger("work-publication");

const publish = async (db: Database) => {
  const composition = await workQueueComposition();
  await publishWorkItems(db, (tx) => insertWorkItems(tx, composition));
};

/**
 * The household web's queue reads the last publication, so counts and pages
 * never evaluate every source. A stale publication is replaced after the
 * response as a tracked `waitUntil` task, so the request's pools stay open
 * until it settles; the commit rings open readers. Only the first read ever
 * waits, and it fails with the raw publication error rather than reading rows
 * no publication completed. A later read keeps serving the last good rows and
 * returns when they were published and the latest attempt's raw error.
 */
export async function readPublishedWorkQueue(
  db: Database,
  read: Omit<Parameters<typeof readWorkQueueWith>[2], "published">,
) {
  let publication = await readWorkPublication(db);
  if (!publication?.publishedAt) {
    await publish(db);
    publication = await readWorkPublication(db);
  } else if (workPublicationStale(publication))
    await afterResponse(
      publish(db).catch((error: unknown) => {
        // SILENT: a failed attempt is recorded and returned with the next read;
        // this catches only the lock or connection around it.
        log.error("work republish failed", { error });
      }),
    );
  // Never serve rows no publication completed: an empty table is not zero work.
  if (!publication?.publishedAt)
    throw new Error(
      publication?.error
        ? `Work items are not published yet; the last attempt failed: ${publication.error}`
        : "Work items are not published yet; the first publication is still running.",
    );
  return readWorkQueueWith(db, await workQueueComposition(), {
    ...read,
    published: {
      meta: publication.meta,
      publishedAt: publication.publishedAt,
      error: publication.error,
    },
  });
}

/** One record's rows of the same sources and routing, evaluated live. */
export const readRecordWorkQueue = async (
  db: Database,
  read: Parameters<typeof readRecordWorkQueueWith>[2],
) => readRecordWorkQueueWith(db, await workQueueComposition(), read);
