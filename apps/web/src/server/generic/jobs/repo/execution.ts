import {
  repositoryBeforeCommit,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";

import { currentJobExecution } from "../context";
import { assertJobClaim } from "./jobs";
export { currentJobExecution, withJobExecution } from "../context";

/** Check external work immediately and database writes again before committing. */
export async function assertCurrentJob(db?: RepositoryQueryInput) {
  const owner = currentJobExecution();
  if (!owner) return;
  if (db) {
    await assertJobClaim(db, owner.claim, true);
    await repositoryBeforeCommit(
      db,
      (tx) => assertJobClaim(tx, owner.claim, true),
      { phase: "publication" },
    );
  } else await assertJobClaim(owner.db, owner.claim);
}
