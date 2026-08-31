import type {
  LedgerPartyId,
  LedgerPartyShortcode,
} from "@cubby/schemas/identifiers";
import type { LedgerPartyKind } from "@cubby/schemas/ledger-party";
import { and, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { DrizzleTransaction } from "~/server/db";
import { ledgerParty } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { notDeleted } from "~/server/repo/database-helpers";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";

/**
 * Resolve live parties while holding FK-compatible locks until the caller's
 * write commits. A party delete/kind-change/merge takes FOR UPDATE, so either
 * the reference lands first and blocks that lifecycle mutation, or this read
 * resumes afterward and observes the tombstone/new kind instead of creating a
 * live edge with stale semantics.
 */
export async function lockLedgerPartiesForReference(
  tx: DrizzleTransaction,
  shortcodes: readonly LedgerPartyShortcode[],
): Promise<Array<{ id: LedgerPartyId; kind: LedgerPartyKind }>> {
  if (shortcodes.length === 0) return [];
  const ids = await resolveAllOrThrow(tx, "ledgerParty", shortcodes);
  const uniqueIds = uniq(ids);
  const rows = await tx
    .select({ id: ledgerParty.id, kind: ledgerParty.kind })
    .from(ledgerParty)
    .where(and(inArray(ledgerParty.id, uniqueIds), notDeleted(ledgerParty)))
    .orderBy(ledgerParty.id)
    .for("key share");
  if (rows.length !== uniqueIds.length)
    throw createAppError(
      "LEDGER_PARTY_NOT_FOUND",
      "A referenced ledger party is no longer live.",
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)!);
}
