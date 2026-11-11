import { moneyToMinor } from "@cubby/shared";
import { uniq } from "es-toolkit";

import { advisoryXactLock } from "~/server/db/advisory-lock";
import { parentTransactionDatabase } from "~/server/db/helpers/core";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { createAppError } from "~/server/errors/app-error";

const heldEvidenceKeys = new WeakMap<object, Set<string>>();

/**
 * Serialize source-owned financial identities before checking their JSONB
 * uniqueness. The rows do not exist yet, so there is nothing useful to lock;
 * a transaction-scoped advisory lock gives every app write the same atomic
 * check-then-write boundary without normalizing the evidence arrays solely to
 * obtain a unique index.
 *
 * Keys are sorted before locking so two writes carrying the same set in a
 * different order cannot deadlock each other.
 */
export async function lockFinancialEvidenceKeys(
  tx: DrizzleTransaction,
  namespace:
    | "account-alias"
    | "source"
    | "reviewed-booking"
    | "transaction-ref",
  keys: readonly string[],
): Promise<void> {
  // JSON escaping keeps evidence values containing NUL delimiters valid UTF-8
  // bind parameters while retaining an unambiguous namespace/key boundary.
  for (const key of uniq(keys).sort((a, b) =>
    JSON.stringify([namespace, a]) < JSON.stringify([namespace, b])
      ? -1
      : JSON.stringify([namespace, a]) > JSON.stringify([namespace, b])
        ? 1
        : 0,
  )) {
    const token = JSON.stringify([namespace, key]);
    let ancestor = parentTransactionDatabase(tx);
    let held = heldEvidenceKeys.get(tx)?.has(token) ?? false;
    while (!held && ancestor) {
      const client = unwrapDb(ancestor);
      held = heldEvidenceKeys.get(client)?.has(token) ?? false;
      ancestor = parentTransactionDatabase(ancestor);
    }
    if (held) continue;
    await advisoryXactLock(unwrapDb(tx), namespace, key);
    let own = heldEvidenceKeys.get(tx);
    if (!own) {
      own = new Set();
      heldEvidenceKeys.set(tx, own);
    }
    own.add(token);
  }
}

/** Legacy evidence doubles must refuse through the financial constraint boundary. */
export const financialEvidenceAmountMinor = (amount: number): bigint => {
  try {
    return moneyToMinor(amount);
  } catch {
    // SILENT: Replace the low-level conversion error with the owning financial constraint.
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Financial evidence amount must be an exact, supported whole-cent amount.",
    );
  }
};
