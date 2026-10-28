import type { Database } from "~/server/db/database";
import {
  repositorySnapshotWriteDatabase,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";

import type { Fenced } from "./types";

/** Member-initiated work owns no Job: its writes are an ordinary transaction. */
export const outsideJob =
  (db: Database): Fenced =>
  (work, options) =>
    (options?.isolationLevel === "serializable"
      ? repositorySnapshotWriteDatabase
      : repositoryTransactionDatabase)(db, work);
