/**
 * A synthetic scope that read one kernel key, for writer tests that assert a
 * write reports its rows: the scope is dirty afterwards exactly when the
 * write raised that key.
 */
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { scopeDep, scopeDirty } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

export async function dependentScope(
  db: Database,
  kind: string,
  key: string,
): Promise<{ dirty(): Promise<boolean>; release(): Promise<void> }> {
  const scopeKey = `synthetic-dependent:${crypto.randomUUID()}`;
  const q = repositoryQueries(db);
  await q.insert(scopeDep).values({ scopeKind: kind, scopeKey, key });
  return {
    async dirty() {
      const rows = await q
        .select({ key: scopeDirty.scopeKey })
        .from(scopeDirty)
        .where(
          and(
            eq(scopeDirty.scopeKind, kind),
            eq(scopeDirty.scopeKey, scopeKey),
          ),
        );
      return rows.length > 0;
    },
    /** Remove the synthetic scope before the kernel would claim it. */
    async release() {
      const own = (table: typeof scopeDep | typeof scopeDirty) =>
        and(eq(table.scopeKind, kind), eq(table.scopeKey, scopeKey));
      await q.delete(scopeDirty).where(own(scopeDirty));
      await q.delete(scopeDep).where(own(scopeDep));
    },
  };
}
