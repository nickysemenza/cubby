import { AsyncLocalStorage } from "node:async_hooks";

import type { Database } from "~/server/db/database";
import {
  repositoryParentDatabase,
  repositoryQueries,
  repositorySnapshotWriteDatabase,
} from "~/server/db/repository-access.boundary";
import { lockCorrectionKey } from "~/server/generic/assessment/repo/correction-lock";

class EmailEvidenceScope {
  declare private readonly scopeIdentity: void;
  constructor() {
    Object.freeze(this);
  }
}

export type EmailEvidenceWriteScope = EmailEvidenceScope;

// Construction alone grants no authority, including through the reachable constructor.
const registered = new WeakMap<EmailEvidenceScope, Database>();
type ActiveScope = { scope: EmailEvidenceScope | null };
const current = new AsyncLocalStorage<ActiveScope>();

const liveRoot = (scope: EmailEvidenceScope) => {
  const root = registered.get(scope);
  return root && repositoryParentDatabase(root) ? root : null;
};

/** Proof of this live transaction's outer gate, never member or source-proof authority. */
export function assertEmailEvidenceScope(
  db: Database,
  scope: unknown,
): asserts scope is EmailEvidenceWriteScope {
  const root = scope instanceof EmailEvidenceScope ? liveRoot(scope) : null;
  if (root) {
    const client = repositoryQueries(root);
    let candidate: Database | undefined = db;
    while (candidate) {
      const next = repositoryQueries(candidate);
      if (!("rollback" in next)) break;
      if (next === client) return;
      candidate = repositoryParentDatabase(candidate);
    }
  }
  throw new Error("Email evidence scope is not active for this transaction");
}

/**
 * DB-only outer entry. Call before Job, Run, Purchase, Original or projection locks.
 * Nested writers carry the capability; they must not acquire a late gate.
 */
export async function withEmailEvidenceWrite<T>(
  db: Database,
  work: (transactionDb: Database, scope: EmailEvidenceWriteScope) => Promise<T>,
): Promise<T> {
  if ("rollback" in repositoryQueries(db))
    throw new Error(
      "Email evidence scope requires a root Database before existing locks",
    );
  const active = current.getStore()?.scope;
  if (active && liveRoot(active))
    throw new Error(
      "Reuse the active Email evidence scope instead of opening another root",
    );
  const entry: ActiveScope = { scope: null };
  return current.run(entry, () =>
    repositorySnapshotWriteDatabase(db, async (transactionDb) => {
      // This physical write is the first domain lock and invalidates stale snapshots.
      await lockCorrectionKey(transactionDb, "email-evidence-write");
      const scope = new EmailEvidenceScope();
      registered.set(scope, transactionDb);
      entry.scope = scope;
      return work(transactionDb, scope);
    }),
  );
}
