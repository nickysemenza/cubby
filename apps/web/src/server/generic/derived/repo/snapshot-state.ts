import {
  snapshotProgress,
  type SnapshotProgress,
} from "@cubby/schemas/derived-snapshot";
import type { KernelJson } from "@cubby/schemas/kernel/machinery";
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";

export const DERIVED_SNAPSHOT_PASS = "derived.snapshot";
export const DERIVED_SNAPSHOT_KEY = "default";

const empty = {
  target: null,
  afterId: null,
  startedAt: null,
  finishedAt: null,
  lastMovementAt: null,
  cleanAt: null,
  failures: 0,
  error: null,
  durationsMs: [],
  pages: 0,
  processedRecords: 0,
  failedPages: 0,
  history: [],
  cursorAttempts: 0,
  passFailures: 0,
};
const cursorSchema = snapshotProgress.omit({ running: true }).extend({
  afterId: z.uuid().nullable(),
  cursorAttempts: z.int().nonnegative(),
  passFailures: z.int().nonnegative(),
});
export type SnapshotCursor = z.infer<typeof cursorSchema>;

export function snapshotCursor(
  raw: KernelJson | null | undefined,
): SnapshotCursor {
  return cursorSchema.parse({
    ...empty,
    ...z.record(z.string(), z.json()).parse(raw ?? {}),
  });
}

/** Published observation and resumable position have one owner: the singleton Pass. */
export async function readSnapshotState(
  db: RepositoryQueryInput,
): Promise<SnapshotProgress> {
  const result = await repositoryQueries(db).execute<{
    cursor: KernelJson;
    running: boolean;
    error: string | null;
  }>(sql`
    SELECT cursor, "doneAt" IS NULL AND "cancelledAt" IS NULL AS running, "lastError" AS error FROM "Pass"
    WHERE name = ${DERIVED_SNAPSHOT_PASS} AND key = ${DERIVED_SNAPSHOT_KEY}`);
  const row = result.rows[0];
  const cursor = snapshotCursor(row?.cursor);
  return snapshotProgress.parse({
    ...cursor,
    running: row?.running ?? false,
    error: cursor.error ?? row?.error ?? null,
  });
}
