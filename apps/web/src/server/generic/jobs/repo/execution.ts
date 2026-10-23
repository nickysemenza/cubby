import {
  repositoryBeforeCommit,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";

import { currentJobExecution } from "../context";
import { assertJobClaim } from "./jobs";
export { currentJobExecution, withJobExecution } from "../context";

/** Check external work immediately and database writes again before committing.
 * Effect-only transactions share ownership; mutations of this Job must acquire
 * their exclusive lock first rather than upgrade after taking domain locks. */
export async function assertCurrentJob(db?: RepositoryQueryInput) {
  const owner = currentJobExecution();
  if (!owner) return;
  if (db) {
    await assertJobClaim(db, owner.claim, "share");
    await repositoryBeforeCommit(
      db,
      (tx) => assertJobClaim(tx, owner.claim, "share"),
      { phase: "publication" },
    );
  } else await assertJobClaim(owner.db, owner.claim);
}
