import type { SearchableEntity } from "@cubby/schemas/search";
import { and, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { suggestionDismissal } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { sha256Hex } from "~/server/semantic/hash";

/**
 * Versioned positional input deliberately avoids free-form JSON key ordering.
 * A schema change bumps the kind/version rather than silently missing a prior
 * dismissal.
 */
export async function suggestionCandidateKey(
  kind: string,
  values: readonly (string | number | boolean | null)[],
): Promise<string> {
  const tuple = [kind, ...values]
    .map((value) => String(value ?? ""))
    .join("\u001f");
  return `v1:${await sha256Hex(tuple)}`;
}

export async function dismissSuggestion(
  db: Database,
  input: {
    entityKind: SearchableEntity;
    entityId: string;
    suggestionKind: string;
    candidateKey: string;
  },
): Promise<void> {
  const now = new Date();
  await getDb(db)
    .insert(suggestionDismissal)
    .values({ ...input, updatedAt: now })
    .onConflictDoUpdate({
      target: [
        suggestionDismissal.entityKind,
        suggestionDismissal.entityId,
        suggestionDismissal.suggestionKind,
        suggestionDismissal.candidateKey,
      ],
      targetWhere: notDeleted(suggestionDismissal),
      set: { deletedAt: null, updatedAt: now },
    });
}

export async function getActiveSuggestionDismissalKeys(
  db: Database,
  input: {
    entityKind: SearchableEntity;
    entityId: string;
    suggestionKind: string;
  },
): Promise<Set<string>> {
  const rows = await getDb(db)
    .select({ candidateKey: suggestionDismissal.candidateKey })
    .from(suggestionDismissal)
    .where(
      and(
        eq(suggestionDismissal.entityKind, input.entityKind),
        eq(suggestionDismissal.entityId, input.entityId),
        eq(suggestionDismissal.suggestionKind, input.suggestionKind),
        notDeleted(suggestionDismissal),
      ),
    );
  return new Set(rows.map((row) => row.candidateKey));
}

export async function softDeleteSuggestionDismissalsTx(
  tx: DrizzleTransaction,
  entityKind: SearchableEntity,
  entityIds: readonly string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  await tx
    .update(suggestionDismissal)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(suggestionDismissal.entityKind, entityKind),
        inArray(suggestionDismissal.entityId, [...entityIds]),
        notDeleted(suggestionDismissal),
      ),
    );
}
