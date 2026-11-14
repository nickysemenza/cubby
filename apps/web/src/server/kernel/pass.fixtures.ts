import { eq, and, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { kernelPass } from "~/server/db/kernel-schema";
import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";

import { fenceClaim, renewClaim, releaseClaim } from "./claim";
import { withWorkContext } from "./context";
import { fencedPublication } from "./pass";

/** Synthetic Pass rows exercise real execution-tuple contention and fences. */
export async function seedPass(
  db: Database,
  row: typeof kernelPass.$inferInsert,
) {
  const [saved] = await repositoryQueries(db)
    .insert(kernelPass)
    .values(row)
    .onConflictDoUpdate({
      target: [kernelPass.name, kernelPass.key],
      set: { ...row, wakeVersion: sql`${kernelPass.wakeVersion} + 1` },
    })
    .returning();
  if (!saved) throw new Error("Synthetic Pass missing");
  return saved;
}
export async function readPasses(
  db: Database,
  filter: { name?: string; key?: string; runId?: string } = {},
) {
  return repositoryQueries(db)
    .select()
    .from(kernelPass)
    .where(
      and(
        filter.name ? eq(kernelPass.name, filter.name) : undefined,
        filter.key ? eq(kernelPass.key, filter.key) : undefined,
        filter.runId ? eq(kernelPass.runId, filter.runId) : undefined,
      ),
    );
}
export async function replacePassWake(db: Database, key: string) {
  return repositoryQueries(db)
    .update(kernelPass)
    .set({ wakeVersion: sql`${kernelPass.wakeVersion} + 1` })
    .where(eq(kernelPass.key, key));
}
export async function lockPass(db: RepositoryQueryInput, key: string) {
  return repositoryQueries(db)
    .select()
    .from(kernelPass)
    .where(eq(kernelPass.key, key))
    .for("update");
}
export async function claimPassFixture(
  db: Database,
  row: { name: string; key: string },
) {
  const token = crypto.randomUUID();
  const target = { table: "Pass" as const, ...row };
  const saved = await repositoryQueries(db)
    .update(kernelPass)
    .set({ claimToken: token, claimDeadline: new Date(Date.now() + 90_000) })
    .where(and(eq(kernelPass.name, row.name), eq(kernelPass.key, row.key)))
    .returning();
  if (!saved.length) throw new Error("Synthetic Pass missing");
  return {
    ...target,
    token,
    renew: () => renewClaim(repositoryQueries(db), target, token),
    release: () => releaseClaim(repositoryQueries(db), target, token),
    fence: (tx: Database) => fenceClaim(repositoryQueries(tx), target, token),
    fenced: <T>(work: (tx: Database) => Promise<T>) =>
      fencedPublication(db, target, token, work),
    owned: <T>(work: () => Promise<T>) => withWorkContext(work),
    cancel: () =>
      repositoryQueries(db)
        .update(kernelPass)
        .set({ cancelledAt: new Date(), claimToken: null, claimDeadline: null })
        .where(and(eq(kernelPass.name, row.name), eq(kernelPass.key, row.key))),
  };
}
