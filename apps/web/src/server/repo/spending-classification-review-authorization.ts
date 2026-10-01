import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";

import { parentTransactionDatabase, unwrapDb } from "./database-helpers";

// Only the server's fingerprint-validated transaction can grant this capability.
// No request field or actor channel is an authorization substitute.
const reviewedDatabases = new WeakSet<object>();

function isReviewedSpendingClassification(
  db: Database | DrizzleTransaction,
): boolean {
  let current: Database | DrizzleTransaction | undefined = db;
  while (current) {
    if (
      reviewedDatabases.has(current) ||
      reviewedDatabases.has(unwrapDb(current))
    )
      return true;
    current = parentTransactionDatabase(current);
  }
  return false;
}

export function assertReviewedSpendingClassification(
  db: Database | DrizzleTransaction,
): void {
  if (!isReviewedSpendingClassification(db))
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "This policy changes historical spending. Preview and apply the reviewed spending classification change.",
    );
}

export async function withReviewedSpendingClassification<T>(
  db: Database,
  apply: () => Promise<T>,
): Promise<T> {
  const client = unwrapDb(db);
  const databaseAlreadyReviewed = reviewedDatabases.has(db);
  const clientAlreadyReviewed = reviewedDatabases.has(client);
  reviewedDatabases.add(db);
  reviewedDatabases.add(client);
  try {
    return await apply();
  } finally {
    if (!databaseAlreadyReviewed) reviewedDatabases.delete(db);
    if (!clientAlreadyReviewed) reviewedDatabases.delete(client);
  }
}
