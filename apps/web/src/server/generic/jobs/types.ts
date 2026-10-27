import type { JobPage } from "@cubby/schemas/job";

import type { Database } from "~/server/db/database";
import type { JobClaim } from "~/server/generic/jobs/repo/queue";

export type PreparedJobPage = {
  page: JobPage;
  /** Domain graph repairs need an outer snapshot, before the Job opens its transaction. */
  isolationLevel?: "serializable";
  /** Only database writes; network and model work belongs in prepare. */
  publish?: (tx: Database) => Promise<void | JobPage["result"]>;
};

/** What the executor lends a page; the lease itself never leaves the module. */
export type JobContext = {
  /** Aborted once the lease is lost; check it at provider boundaries. */
  readonly signal: AbortSignal;
  /**
   * A transaction that commits only while this claim still owns its Job:
   * domain locks first, then the Job row is locked and checked before commit.
   * Drains publish chunks here; a paid result can persist here before publish.
   */
  fenced<T>(
    work: (tx: Database) => Promise<T>,
    options?: { isolationLevel?: "serializable" },
  ): Promise<T>;
};

export type JobHandler = {
  prepare(
    db: Database,
    job: JobClaim,
    context: JobContext,
  ): Promise<PreparedJobPage>;
};
export type JobHandlers = Readonly<Record<string, JobHandler>>;
