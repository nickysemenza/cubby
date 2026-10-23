import { recordCommittedChanges } from "~/server/db/helpers/core";
import {
  repositoryBeforeCommit,
  repositoryAfterCommit,
  repositoryParentDatabase,
  repositoryTransaction,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import {
  refreshFamily,
  invalidateRefreshFamily,
  type RefreshFamily,
} from "~/server/generic/derived-refresh/repo/families";

/** Projection publications notify readers without restarting authoritative refresh. */
export type RepositoryChange =
  | { kind: "source"; categories: readonly string[] }
  | {
      kind: "projection";
      categories: readonly string[];
      /** Explicit downstream inputs; this does not infer or traverse dependencies. */
      refresh?: readonly RefreshFamily[];
    };

/**
 * Register source intent and reader hints at the caller's commit boundary.
 * Source writers must pass their save transaction; a call after saving on a
 * pooled handle cannot make that earlier save atomic with Job enrollment.
 */
export async function recordChange(
  db: RepositoryQueryInput,
  change: RepositoryChange,
): Promise<void> {
  // Run source state is completed-import evidence for Email quality. Progress
  // publications remain projection metadata and enroll no family by default.
  const families =
    change.kind === "projection"
      ? (change.refresh ?? [])
      : change.categories.length > 0 &&
          change.categories.every(
            (category) => category === "run" || category === "auditLog",
          )
        ? change.categories.includes("run")
          ? ["quality"]
          : []
        : refreshFamily.options;
  if (families.length && !("rollback" in db) && !repositoryParentDatabase(db)) {
    await repositoryTransaction(db, (tx) => recordChange(tx, change));
    return;
  }
  await recordCommittedChanges(db, change.categories);
  for (const family of refreshFamily.options.filter((family) =>
    families.includes(family),
  ))
    await repositoryBeforeCommit(
      db,
      (tx) => invalidateRefreshFamily(tx, family),
      {
        key: `refresh:${family}`,
      },
    );
  if (!families.length) return;
  await repositoryBeforeCommit(
    db,
    async (tx) => {
      await repositoryAfterCommit(tx, async () => {
        const { wakeJobs } =
          await import("~/server/workflows/background-tasks/publish");
        await wakeJobs({ source: "repository.change" });
      });
    },
    { key: "refresh:wake" },
  );
}
