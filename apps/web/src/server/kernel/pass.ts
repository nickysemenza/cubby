/**
 * Passes (ADR 0029 section 7): one row per registered pass instance with a
 * resumable cursor under the shared claim. A pass page publishes only while
 * its claim is live; a cancelled or lapsed claim writes nothing.
 */
import { kernelWaitCause } from "@cubby/schemas/kernel/machinery";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";

import {
  claimPass,
  fenceClaim,
  renewClaim,
  settleFailure,
  type ClaimedPass,
} from "./claim";
import type { Claim, Json, Pass } from "./define";
import type { KernelRegistry } from "./registry";
import { wakeAfterCommit } from "./wake";

/** Start (or restart a finished) pass instance; a pending one keeps its cursor. */
export async function startPass(
  db: Database,
  pass: Pass,
  options: {
    key?: string;
    cursor?: Json | null;
    runId?: string | null;
    availableAt?: Date;
  } = {},
): Promise<void> {
  // Database time, not the Worker's clock: a skewed clock must not park the pass.
  const at = options.availableAt
    ? sql`${options.availableAt.toISOString()}::timestamp`
    : sql`now()`;
  await repositoryQueries(db).execute(sql`
    INSERT INTO "Pass" (name, key, cursor, "runId", "availableAt")
    VALUES (${pass.name}, ${options.key ?? "default"}, ${JSON.stringify(options.cursor ?? null)}::jsonb,
      ${options.runId ?? null}::uuid, ${at})
    ON CONFLICT (name, key) DO UPDATE SET
      cursor = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
        THEN CASE WHEN "Pass".cursor ? ${"legacyJobs"} THEN
          coalesce(nullif(excluded.cursor, 'null'::jsonb), '{}'::jsonb) || jsonb_build_object(${"legacyJobs"}::text, "Pass".cursor->${"legacyJobs"})
          ELSE excluded.cursor END
        ELSE "Pass".cursor END,
      attempts = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
        THEN 0 ELSE "Pass".attempts END,
      "claimToken" = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
        THEN NULL ELSE "Pass"."claimToken" END,
      "claimDeadline" = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
        THEN NULL ELSE "Pass"."claimDeadline" END,
      "waitCause" = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
        THEN NULL ELSE "Pass"."waitCause" END,
      "lastError" = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
        THEN NULL ELSE "Pass"."lastError" END,
      "runId" = coalesce(excluded."runId", "Pass"."runId"),
      "doneAt" = NULL, "cancelledAt" = NULL,
      "availableAt" = CASE WHEN "Pass"."waitCause" = ${kernelWaitCause.enum.funding} AND "Pass"."doneAt" IS NULL AND "Pass"."cancelledAt" IS NULL THEN "Pass"."availableAt" ELSE least("Pass"."availableAt", excluded."availableAt") END,
      "wakeVersion" = CASE WHEN "Pass"."waitCause" = ${kernelWaitCause.enum.funding} AND "Pass"."doneAt" IS NULL AND "Pass"."cancelledAt" IS NULL THEN "Pass"."wakeVersion" ELSE "Pass"."wakeVersion" + 1 END, "updatedAt" = now()`);
  await wakeAfterCommit(db);
}

function passClaim(db: Database, claimed: ClaimedPass): Claim {
  const target = {
    table: "Pass" as const,
    name: claimed.name,
    key: claimed.key,
  };
  const controller = new AbortController();
  return {
    token: claimed.token,
    deadline: claimed.deadline,
    signal: controller.signal,
    async renew() {
      const held = await renewClaim(
        repositoryQueries(db),
        target,
        claimed.token,
      );
      if (!held) controller.abort();
      return held;
    },
    fence: (tx) => fenceClaim(repositoryQueries(tx), target, claimed.token),
    fenced: (work) =>
      repositoryTransactionDatabase(db, async (tx) => {
        await fenceClaim(repositoryQueries(tx), target, claimed.token);
        return work(tx);
      }),
  };
}

/** Claim and run one due pass page; false when none was due. */
export async function runOnePass(
  db: Database,
  registry: KernelRegistry,
): Promise<boolean> {
  const claimed = await claimPass(db, [...registry.passes.values()]);
  if (!claimed) return false;
  const pass = registry.passes.get(claimed.name)!;
  const target = {
    table: "Pass" as const,
    name: claimed.name,
    key: claimed.key,
  };
  const claim = passClaim(db, claimed);
  try {
    // SAFETY: the cursor column holds the JSON the pass last returned.
    const result = await pass.run(db, claimed.cursor as Json | null, claim);
    await claim.fenced(async (tx) => {
      await result.publish?.(tx);
      await repositoryQueries(tx).execute(sql`
        UPDATE "Pass" SET cursor = CASE WHEN "wakeVersion" = ${claimed.wakeVersion} THEN
            CASE WHEN cursor ? ${"legacyJobs"} THEN
              coalesce(nullif(${JSON.stringify(result.cursor)}::jsonb, 'null'::jsonb), '{}'::jsonb) || jsonb_build_object(${"legacyJobs"}::text, cursor->${"legacyJobs"})
              ELSE ${JSON.stringify(result.cursor)}::jsonb END
            ELSE cursor END,
          "doneAt" = CASE WHEN "wakeVersion" = ${claimed.wakeVersion} AND ${result.done} THEN now() ELSE NULL END,
          "availableAt" = CASE WHEN "wakeVersion" = ${claimed.wakeVersion} THEN ${result.availableAt ? sql`${result.availableAt.toISOString()}::timestamp` : sql`now()`} ELSE least("availableAt", now()) END,
          attempts = 0, "claimToken" = NULL, "claimDeadline" = NULL,
          "waitCause" = CASE WHEN "wakeVersion" = ${claimed.wakeVersion} THEN ${result.done ? null : (result.waitCause ?? null)} ELSE NULL END, "lastError" = NULL, "updatedAt" = now()
        WHERE name = ${claimed.name} AND key = ${claimed.key}`);
    });
  } catch (error) {
    await settleFailure(
      repositoryQueries(db),
      target,
      claimed.token,
      claimed.attempts,
      error,
      claimed.wakeVersion,
    );
  }
  return true;
}
