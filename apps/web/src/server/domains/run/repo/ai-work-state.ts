import { isMemberStartedRun } from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  assertWorkflowEffect,
  currentRunExecution,
} from "~/server/workflows/runs/execution";
export type RunRow = typeof run.$inferSelect;
type RunUpdate = PgUpdateSetSource<typeof run>;

export async function readRun(
  db: Database,
  runId: RunRow["id"],
  { live = false }: { live?: boolean } = {},
): Promise<RunRow | undefined> {
  const [row] = await getDb(db)
    .select()
    .from(run)
    .where(and(eq(run.id, runId), live ? notDeleted(run) : undefined));
  return row;
}

/** Actor columns for one sweep page. Omits progress history and Run input. */
export async function readRunActor(db: Database, runId: RunRow["id"]) {
  const [row] = await getDb(db)
    .select({
      id: run.id,
      actorUserId: run.actorUserId,
      channel: run.channel,
      oauthClientId: run.oauthClientId,
      deviceId: run.deviceId,
    })
    .from(run)
    .where(eq(run.id, runId));
  return row;
}

export async function readRunStatus(db: Database, runId: RunRow["id"]) {
  const [row] = await getDb(db)
    .select({ status: run.status })
    .from(run)
    .where(eq(run.id, runId));
  return row?.status;
}

/** Writes a checkpoint only for its current Job generation and live token. */
export async function writeRunningAttemptProgress(
  db: Database,
  runId: RunRow["id"],
  attempt: number,
  set: RunUpdate,
) {
  const execution = currentRunExecution();
  if (
    !execution ||
    execution.runId !== runId ||
    execution.generation !== attempt
  )
    throw new Error("Run checkpoint requires its current execution claim");
  const write = async (target: Database) => {
    const written = await getDb(target)
      .update(run)
      .set(set)
      .where(and(eq(run.id, runId), eq(run.status, "running")))
      .returning({
        id: run.id,
        shortcode: run.shortcode,
        purpose: run.purpose,
        trigger: run.trigger,
      });
    if (written[0]) {
      await (
        await import("~/server/kernel/api")
      ).emitWrites(target, {
        table: run,
        entity: "run",
        ids: [runId],
        columns: Object.keys(set),
      });
      await (
        await import("./work-progress")
      ).checkpointRunWorkProgress(target, written[0].shortcode);
    }
    if (
      written[0] &&
      (set.status !== undefined ||
        set.endedAt !== undefined ||
        set.startedAt !== undefined)
    )
      await recordChange(target, {
        kind: "source",
        categories: ["run"],
        ringFromBackground: isMemberStartedRun(written[0]),
      });
    return written.length > 0;
  };
  return withTransactionDatabase(db, async (tx) => {
    await assertWorkflowEffect(tx);
    // Under READ COMMITTED an UPDATE that waits on the Run row rechecks only that
    // row, not its NOT EXISTS subquery. Taking the lock first gives the guarded
    // UPDATE a fresh snapshot that sees work discovery committed under the lock.
    await getDb(tx)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.id, runId))
      .for("no key update");
    return write(tx);
  });
}
