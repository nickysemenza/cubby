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
 * waits.
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
        // SILENT: the next stale read retries; the previous rows stay readable.
        log.error("work republish failed", { error });
      }),
    );
  return readWorkQueueWith(db, await workQueueComposition(), {
    ...read,
    published: { meta: publication?.meta ?? null },
  });
}

/** One record's rows of the same sources and routing, evaluated live. */
export const readRecordWorkQueue = async (
  db: Database,
  read: Parameters<typeof readRecordWorkQueueWith>[2],
) => readRecordWorkQueueWith(db, await workQueueComposition(), read);
