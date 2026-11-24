import type { DatabaseChanges } from "~/lib/doorbell";
import { inHttpRequest } from "~/server/db/freshness/member-marker";
import { recordCommittedChanges } from "~/server/db/helpers/core";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";

/**
 * Reader notifications. `kind` describes the write; notification treats
 * source and projection writes alike.
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
 * Notify readers of committed categories when a member is waiting on them.
 * Kernel work a write creates wakes the runner from its own writer
 * (ADR 0029 section 7), so a source write alone sends no queue permit.
 */
export async function recordChange(
  db: RepositoryQueryInput,
  change: RepositoryChange,
): Promise<void> {
  if (!change.ringFromBackground && !inHttpRequest()) return;
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
