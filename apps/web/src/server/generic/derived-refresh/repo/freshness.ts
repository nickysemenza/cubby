import { derivedRefreshState } from "@cubby/schemas/derived-refresh";
import type { Entity } from "@cubby/schemas/entity-core";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  unwrapDb,
  runBeforeCommitDatabase,
  pendingTransactionChanges,
} from "~/server/db/helpers";
import { derivedRefreshRevision, derivedRefreshWork } from "~/server/db/schema";
import { DerivedInputsChanged } from "~/server/generic/derived-refresh/repo/revisions";

import { refreshDependencyRoutes } from "./dependencies";
export {
  currentInputRevision,
  DerivedInputsChanged,
} from "~/server/generic/derived-refresh/repo/revisions";

/** Finite declaration traversal; this never traverses household records. */
export function refreshInputKinds(kind: string): Entity[] {
  const found = new Set<string>([kind]);
  let changed = true;
  while (changed) {
    changed = false;
    // Every declaration owner is an Entity; missing routes are empty.
    for (const candidate of entityKinds) {
      if (
        !found.has(candidate) &&
        refreshDependencyRoutes(candidate).some((route) =>
          found.has(route.entity),
        )
      ) {
        found.add(candidate);
        changed = true;
      }
    }
  }
  return entityKinds.filter((candidate) => found.has(candidate));
}

import { entitySchema } from "@cubby/schemas/entity";
const entityKinds = entitySchema.options;

export async function hasUnmaterializedInputs(
  db: Database | DrizzleTransaction,
  kinds: readonly string[],
  options: { includePublishing?: boolean; pendingOnly?: boolean } = {},
) {
  if (kinds.length === 0) return false;
  const [row] = await unwrapDb(db)
    .select({ id: derivedRefreshWork.id })
    .from(derivedRefreshWork)
    .where(
      and(
        inArray(
          derivedRefreshWork.entityKind,
          entityKinds.filter((kind) => kinds.includes(kind)),
        ),
        options.pendingOnly
          ? eq(derivedRefreshWork.state, "pending")
          : sql`${derivedRefreshWork.state} <> ${derivedRefreshState.enum.completed}`,
        options.includePublishing
          ? undefined
          : sql`(${derivedRefreshWork.hasFailures} OR NOT ${derivedRefreshWork.publishing})`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Output writes precede this short lock; scopes/acknowledgement follow it. */
export async function assertInputRevision(
  db: Database | DrizzleTransaction,
  expected: number,
) {
  if (expected === 0)
    await unwrapDb(db)
      .insert(derivedRefreshRevision)
      .values({ key: "all", revision: 0 })
      .onConflictDoNothing();
  const rows = await unwrapDb(db)
    .update(derivedRefreshRevision)
    .set({ revision: sql`${derivedRefreshRevision.revision}` })
    .where(
      and(
        eq(derivedRefreshRevision.key, "all"),
        eq(derivedRefreshRevision.revision, expected),
      ),
    )
    .returning({ key: derivedRefreshRevision.key });
  if (rows.length === 0)
    throw new DerivedInputsChanged(
      "Derived inputs changed during publication; retry current inputs",
    );
}

/** Freeze the publication's intended changes; later writes in a caller's batch invalidate it. */
export async function fenceDerivedInputsAtCommit(
  db: Database,
  revision: number,
  fingerprint: (tx: Database) => Promise<string>,
) {
  const expected = await fingerprint(db);
  const pending = JSON.stringify(pendingTransactionChanges(db).sort());
  await runBeforeCommitDatabase(
    db,
    async (tx) => {
      if (
        (await fingerprint(tx)) !== expected ||
        JSON.stringify(pendingTransactionChanges(tx).sort()) !== pending
      )
        throw new DerivedInputsChanged(
          "Derived inputs changed later in the same transaction",
        );
    },
    "validation",
  );
  await runBeforeCommitDatabase(
    db,
    (tx) => assertInputRevision(tx, revision),
    "fence",
  );
}
