import type { SearchableEntity } from "@cubby/schemas/search";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { suggestionDismissal } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

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
  return `v1:${toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tuple)))}`;
}

export async function dismissSuggestion(
  db: Database,
  input: {
    sourceEntityType: SearchableEntity;
    sourceEntityId: string;
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
        suggestionDismissal.sourceEntityType,
        suggestionDismissal.sourceEntityId,
        suggestionDismissal.suggestionKind,
        suggestionDismissal.candidateKey,
      ],
      targetWhere: isNull(suggestionDismissal.deletedAt),
      set: { deletedAt: null, updatedAt: now },
    });
}

export async function softDeleteSuggestionDismissalsTx(
  tx: DrizzleTransaction,
  sourceEntityType: SearchableEntity,
  sourceEntityIds: readonly string[],
): Promise<void> {
  if (sourceEntityIds.length === 0) return;
  await tx
    .update(suggestionDismissal)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(suggestionDismissal.sourceEntityType, sourceEntityType),
        inArray(suggestionDismissal.sourceEntityId, [...sourceEntityIds]),
        isNull(suggestionDismissal.deletedAt),
      ),
    );
}
