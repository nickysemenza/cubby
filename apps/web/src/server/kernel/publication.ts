import type { Database } from "~/server/db/database";
import { repositoryHouseholdWriteDatabase } from "~/server/db/repository-access.boundary";

export type Publication = <T>(work: (tx: Database) => Promise<T>) => Promise<T>;
/**
 * A domain command's publication: the gate before any row it locks.
 * Background callers supply their live claim's fenced transaction instead.
 */
export const publishTransaction =
  (db: Database): Publication =>
  (work) =>
    repositoryHouseholdWriteDatabase(db, work);
