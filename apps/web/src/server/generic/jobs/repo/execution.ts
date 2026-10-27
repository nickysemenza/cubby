import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";

import { currentJobExecution } from "../context";
import { assertJobClaim, fenceJob } from "./queue";
export { currentJobExecution, withJobExecution } from "../context";

/** Check external work immediately; fence database writes at commit (domain locks first). */
export async function assertCurrentJob(db?: RepositoryQueryInput) {
  const owner = currentJobExecution();
  if (!owner) return;
  if (db) await fenceJob(db, owner.claim);
  else await assertJobClaim(owner.db, owner.claim);
}
