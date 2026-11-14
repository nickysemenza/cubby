import { runEntityId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  runPassCursor,
  isPassRunPurpose,
  RUN_EXECUTE_PASS,
} from "~/server/domains/run/repo/run-execution";
import { fenceClaim, releaseClaim, renewClaim } from "~/server/kernel/claim";

import { withWorkflowExecution } from "./execution";

/** Borrow the persisted Pass claim so scripted step journeys use production fences. */
export async function runPassFixture(db: Database, runId: string) {
  runEntityId.parse(runId);
  const q = repositoryQueries(db);
  const existing = await q.execute<{
    purpose: string;
    progress: { attempt?: number } | null;
  }>(sql`SELECT purpose, progress FROM "Run" WHERE id = ${runId}::uuid`);
  const owner = existing.rows[0];
  if (!owner || !isPassRunPurpose(owner.purpose))
    throw new Error("Synthetic executed Run missing");
  const pending = await q.execute<{ key: string }>(
    sql`SELECT key FROM "Pass" WHERE name = ${RUN_EXECUTE_PASS} AND key = ${runId}`,
  );
  if (!pending.rows.length) {
    const { startRunPass } = await import("./run-pass");
    await startRunPass(db, {
      runId: runEntityId.parse(runId),
      purpose: owner.purpose,
      generation: owner.progress?.attempt || 1,
      restart: false,
    });
  }
  const token = crypto.randomUUID();
  const result = await q.execute<{ cursor: unknown }>(sql`
    UPDATE "Pass" SET "claimToken" = ${token}::uuid, "claimDeadline" = now() + interval '90 seconds'
    WHERE name = ${RUN_EXECUTE_PASS} AND key = ${runId} AND "cancelledAt" IS NULL
      AND "doneAt" IS NULL AND ("claimToken" IS NULL OR "claimDeadline" <= now()) RETURNING cursor`);
  const cursor = runPassCursor.parse(result.rows[0]?.cursor);
  const target = { table: "Pass" as const, name: RUN_EXECUTE_PASS, key: runId };
  const context = {
    fence: (tx: Database) => fenceClaim(repositoryQueries(tx), target, token),
    async check() {
      if (!(await renewClaim(q, target, token)))
        throw new Error("Pass claim is obsolete");
    },
  };
  return {
    generation: cursor.generation,
    release: () => releaseClaim(q, target, token),
    owned: <T>(work: () => Promise<T>) =>
      withWorkflowExecution(
        {
          runId,
          attempt: cursor.generation,
          database: db,
          recovered: true,
          claim: context,
          live: sql<boolean>`EXISTS (SELECT 1 FROM "Pass" WHERE name = ${RUN_EXECUTE_PASS} AND key = ${runId}
        AND "claimToken" = ${token}::uuid AND "claimDeadline" > now() AND "cancelledAt" IS NULL)`,
        },
        work,
      ),
  };
}

export async function withRunPassFixture<T>(
  db: Database,
  runId: string,
  work: () => Promise<T>,
): Promise<T> {
  const claim = await runPassFixture(db, runId);
  try {
    return await claim.owned(work);
  } finally {
    await claim.release();
  }
}

/** Drive exactly one production Run Pass page without unrelated kernel work. */
export async function advanceRunPass(db: Database) {
  const { createKernel, defineModule } = await import("~/server/kernel/api");
  const { runOnePass } = await import("~/server/kernel/pass");
  const { runExecutePass } = await import("./run-pass");
  const kernel = createKernel([
    defineModule({ name: "synthetic.run", passes: [runExecutePass] }),
  ]);
  return runOnePass(db, kernel.registry);
}
