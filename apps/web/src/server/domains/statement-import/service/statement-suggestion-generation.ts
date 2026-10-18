import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { runEntityId } from "@cubby/schemas/identifiers";

import { getBackgroundQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  generateStatementSuggestionPage,
  type ChargeRef,
} from "~/server/domains/statement-import/repo/statement-suggestions";
import { labelStatementSuggestions } from "~/server/domains/statement-import/service/statement-suggestion-labels";
import {
  publishBackgroundTasks,
  publishInBackground,
} from "~/server/workflows/background-tasks/publish";

const pageTask = (after: ChargeRef | null) => ({
  kind: "statement-suggestions.generate" as const,
  requestedAt: new Date().toISOString(),
  after,
});

/**
 * Start a full generation pass once the caller's write commits. Without a
 * queue binding (Node dev, tests) nothing is published; the member's Refresh
 * action pages inline instead.
 */
export function scheduleStatementSuggestions(db: Database): Promise<void> {
  if (!getBackgroundQueue()) return Promise.resolve();
  return publishInBackground(db, [pageTask(null)], {
    source: "statement-suggestions",
  });
}

const labelTask = () => ({
  kind: "statement-suggestions.label" as const,
  requestedAt: new Date().toISOString(),
});

/** Queue consumer: one page, then hand the cursor to the next message. */
export async function continueStatementSuggestions(
  db: Database,
  task: Extract<BackgroundTask, { kind: "statement-suggestions.generate" }>,
) {
  const page = await generateStatementSuggestionPage(db, {
    after: task.after,
    runId: task.runId ?? null,
  });
  await publishBackgroundTasks(
    db,
    [
      ...(page.next ? [pageTask(page.next)] : []),
      ...(page.published ? [labelTask()] : []),
    ],
    { source: "statement-suggestions" },
  );
  return page.published ? ("succeeded" as const) : ("skipped" as const);
}

/** Queue consumer: one label batch, continuing while batches make progress. */
export async function continueStatementSuggestionLabels(
  db: Database,
  task: Extract<BackgroundTask, { kind: "statement-suggestions.label" }>,
) {
  const outcome = await labelStatementSuggestions(db, {
    runId: task.runId ? runEntityId.parse(task.runId) : null,
  });
  if (outcome.remaining)
    await publishBackgroundTasks(db, [labelTask()], {
      source: "statement-suggestions.label",
    });
  return outcome.labelled ? ("succeeded" as const) : ("skipped" as const);
}

/**
 * A member-requested refresh: the first page runs now so its results are
 * visible on return, and the remainder continues on the queue. With no queue
 * the caller receives the cursor and pages again.
 */
export async function refreshStatementSuggestions(
  db: Database,
  input: { after: ChargeRef | null },
) {
  const page = await generateStatementSuggestionPage(db, {
    after: input.after,
    runId: null,
  });
  const queued = Boolean(page.next && getBackgroundQueue());
  if (getBackgroundQueue())
    await publishBackgroundTasks(
      db,
      [
        ...(page.next ? [pageTask(page.next)] : []),
        ...(page.published ? [labelTask()] : []),
      ],
      { source: "statement-suggestions.refresh" },
    );
  return {
    published: page.published,
    unchanged: page.unchanged,
    next: queued ? null : page.next,
    queued,
  };
}
