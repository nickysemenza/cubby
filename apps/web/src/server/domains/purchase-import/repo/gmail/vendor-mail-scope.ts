/**
 * The exact sender/domain searches a vendor-scoped history backfill may run.
 * Verified receipt senders and the Vendor's website domain seed them; a Vendor
 * name never does, so an approval never widens into free-text or all-history
 * discovery. A domain is a discovery hint: classification still decides each
 * message and attribution still gates its import.
 */
import type { VendorId } from "@cubby/schemas/identifiers";
import type { MailboxScopedQuery } from "@cubby/schemas/mailbox-research";
import { and, inArray } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { vendor } from "~/server/db/retained-tables";
import { vendorSearchTerms } from "~/server/domains/purchase-import/repo/gmail/vendor-identity";

export type VendorMailPrerequisite = {
  vendorId: VendorId;
  queries: MailboxScopedQuery[];
  /** Research the Work queue routes to Claude/Codex before history can start. */
  blockers: ("vendor_not_found" | "no_verified_sender_or_website")[];
};

const gmailDate = (date: string) => date.replaceAll("-", "/");

// Gmail operators, quotes or spaces in a stored sender would widen `from:`.
const LITERAL_SENDER =
  /^(?:[a-z0-9._%+-]+@)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/** Frozen per-term queries; the history window is the approval's, never the caller's. */
export function vendorHistoryQueries(
  vendorId: VendorId,
  terms: readonly string[],
): MailboxScopedQuery[] {
  return terms
    .filter((term) => LITERAL_SENDER.test(term))
    .map((term) => ({
      // Platform mail can name the seller's domain in links while using a
      // shared sender. A literal domain searches that evidence too.
      key: `vendor:${vendorId}:${term.includes("@") ? "from" : "domain"}:${term}`,
      query: term.includes("@") ? `from:${term}` : `"${term}"`,
    }));
}

/**
 * Gmail's own date operators bound every frozen query to the approved window.
 * The window is part of the coverage key: completing one window never marks
 * another window of the same sender as scanned.
 */
export function windowedVendorQuery(
  query: MailboxScopedQuery,
  window: { receivedAfter: string | null; receivedBefore: string },
): MailboxScopedQuery {
  return {
    key: `${query.key}:${window.receivedAfter ?? "start"}..${window.receivedBefore}`,
    query: [
      `(${query.query})`,
      window.receivedAfter ? `after:${gmailDate(window.receivedAfter)}` : null,
      `before:${gmailDate(window.receivedBefore)}`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export async function readVendorMailPrerequisites(
  db: Database,
  vendorIds: readonly VendorId[],
): Promise<VendorMailPrerequisite[]> {
  const rows = vendorIds.length
    ? await getDb(db)
        .select({
          id: vendor.id,
          website: vendor.website,
          orderEmailSenders: vendor.orderEmailSenders,
        })
        .from(vendor)
        .where(and(inArray(vendor.id, [...vendorIds]), notDeleted(vendor)))
    : [];
  return vendorIds.map((vendorId) => {
    const row = rows.find((candidate) => candidate.id === vendorId);
    if (!row) return { vendorId, queries: [], blockers: ["vendor_not_found"] };
    const queries = vendorHistoryQueries(vendorId, vendorSearchTerms(row));
    return {
      vendorId,
      queries,
      blockers: queries.length ? [] : ["no_verified_sender_or_website"],
    };
  });
}
