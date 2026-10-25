import type { Database } from "~/server/db/database";
import { recordCommittedChanges } from "~/server/db/helpers/core";
import {
  repositoryBeforeCommit,
  repositoryAfterCommit,
  repositoryParentDatabase,
  repositoryTransaction,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";

/** Assessment saves register durable correction intent through the same composition boundary. */
export async function recordAssessmentChange(
  db: Database,
  change:
    | { kind: "publications"; ids: readonly string[] }
    | { kind: "application"; receiptId: string },
): Promise<void> {
  const { recordCorrectionWork } =
    await import("~/server/generic/assessment/repo/correction-work");
  await recordCorrectionWork(db, change);
}

/**
 * Reader notifications. Derived work needs no registration here: generated
 * triggers mark it in the writer's transaction (ADR 0021).
 */
export type RepositoryChange = {
  kind: "source" | "projection";
  categories: readonly string[];
};

/**
 * Notify readers of committed categories, and wake the Job drain after a
 * source write commits so derived marks are worked promptly.
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
  await recordCommittedChanges(db, change.categories);
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
