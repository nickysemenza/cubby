import type { JobPage } from "@cubby/schemas/job";

import type { Database } from "~/server/db/database";
import type { JobClaim } from "~/server/generic/jobs/repo/jobs";

export type PreparedJobPage = {
  page: JobPage;
  /** Domain graph repairs need an outer snapshot, before the Job opens its transaction. */
  isolationLevel?: "serializable";
  /** A device now owns the persisted lease; only a current receipt or expiry settles it. */
  awaitExternal?: true;
  /** Only database writes; network and model work belongs in prepare. */
  publish?: (tx: Database) => Promise<void | JobPage["result"]>;
  /** Completed pages sharing this object publish under one set of lease fences. */
  publicationGroup?: {
    publish(tx: Database, ids: ReadonlySet<string>): Promise<void>;
  };
};
export type JobHandler = {
  /** Optional finite set executor; the drain admits one service turn per fair round. */
  advancePage?: (db: Database, anchorId: string) => Promise<string>;
  prepare(db: Database, job: JobClaim): Promise<PreparedJobPage>;
  /** One lane executes a bounded kind batch; every checkpoint publishes separately. */
  batch?: {
    size: number;
    execute(
      db: Database,
      claims: readonly JobClaim[],
      context: {
        deadline: number;
        /** Await publication of this completed chunk before starting more work. */
        checkpoint(
          results: ReadonlyMap<string, PromiseSettledResult<PreparedJobPage>>,
        ): Promise<void>;
      },
    ): Promise<void>;
  };
};
export type JobHandlers = Readonly<Record<string, JobHandler>>;
