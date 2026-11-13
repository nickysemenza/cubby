import type { Database } from "~/server/db/database";
import {
  repositorySnapshotWriteDatabase,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
export type Publication = <T>(
  work: (tx: Database) => Promise<T>,
  options?: { isolationLevel?: "serializable" },
) => Promise<T>;
/** A domain command's publication; background callers supply their live claim instead. */
export const publishTransaction =
  (db: Database): Publication =>
  (work, options) =>
    (options?.isolationLevel === "serializable"
      ? repositorySnapshotWriteDatabase
      : repositoryTransactionDatabase)(db, work);
