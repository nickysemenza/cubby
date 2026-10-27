import type { Database } from "~/server/db";
import {
  readRecordWorkQueueWith,
  readWorkQueueWith,
} from "~/server/generic/work-queue/repo/work-queue";

import { workQueueComposition } from "./work-queue-composition";

/** The household or member queue over every composed work source. */
export const readWorkQueue = (
  db: Database,
  read: Parameters<typeof readWorkQueueWith>[2],
) => readWorkQueueWith(db, workQueueComposition(), read);

/** One record's rows of the same sources and routing. */
export const readRecordWorkQueue = (
  db: Database,
  read: Parameters<typeof readRecordWorkQueueWith>[2],
) => readRecordWorkQueueWith(db, workQueueComposition(), read);
