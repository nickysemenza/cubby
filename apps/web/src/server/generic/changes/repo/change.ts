import type { DatabaseChanges } from "~/lib/doorbell";
import { inHttpRequest } from "~/server/db/freshness/member-marker";
import { recordCommittedChanges } from "~/server/db/helpers/core";
import {
  repositoryBeforeCommit,
  repositoryAfterCommit,
  repositoryParentDatabase,
  repositoryTransaction,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";

/**
 * Reader notifications. Derived work needs no registration here: generated
 * triggers mark it in the writer's transaction (ADR 0021).
 */
export type RepositoryChange = {
  kind: "source" | "projection";
  categories: readonly string[];
  /** Public shortcodes for categories whose affected records are known. */
  changes?: DatabaseChanges;
  /**
   * Requests always ring open tabs. A queue, cron or Durable Object commit
   * rings only when a member is waiting on it: a member-started Run transition,
   * image completion or priority-0 derived publication.
   */
  ringFromBackground?: boolean;
};

/**
 * Notify readers of committed categories when a member is waiting on them, and
 * wake the Job drain after a source write commits so derived marks are worked
 * promptly.
 */
export async function recordChange(
  db: RepositoryQueryInput,
  change: RepositoryChange,
): Promise<void> {
  if (
    change.kind === "source" &&
    !("rollback" in db) &&
    !repositoryParentDatabase(db)
  ) {
    await repositoryTransaction(db, (tx) => recordChange(tx, change));
    return;
  }
  if (change.ringFromBackground || inHttpRequest()) {
    await recordCommittedChanges(
      db,
      Object.fromEntries(
        change.categories.map((category) => [
          category,
          change.changes?.[category] ?? null,
        ]),
      ),
    );
  }
  if (change.kind !== "source") return;
  await repositoryBeforeCommit(
    db,
    async (tx) => {
      await repositoryAfterCommit(tx, async () => {
        const { wakeJobs } =
          await import("~/server/workflows/background-tasks/publish");
        await wakeJobs({ source: "repository.change" });
      });
    },
    { key: "derived:wake" },
  );
}
