/**
 * The exact sender/domain searches automatic discovery runs for a known Vendor.
 * Verified receipt senders and the Vendor's website domain seed them; a Vendor
 * name never does, so discovery never widens into free-text or all-history
 * search. A domain is a discovery hint: classification still decides each
 * message and attribution still gates its import.
 */
import type { VendorId } from "@cubby/schemas/identifiers";
import type { ControlledMailImportInput } from "@cubby/schemas/mail-coverage-control";
import type { MailboxScopedQuery } from "@cubby/schemas/mailbox-research";

import { householdDateTime, shiftPlainDate } from "~/lib/household-date";

/** Candidate retrieval never includes Spam or Trash, in previews or discovery. */
export function eligibleMailSearchQuery(query: string): string {
  return `(${query}) -in:spam -in:trash`;
}

/** Preview and import use the same inclusive household days, including DST. */
export function mailSearchDateRange(
  query: string,
  range: Pick<ControlledMailImportInput, "from" | "to">,
): string {
  if (!range.from && !range.to) return query;
  return [
    `(${query})`,
    range.from
      ? `after:${Math.floor(householdDateTime(range.from).getTime() / 1000) - 1}`
      : null,
    range.to
      ? `before:${Math.floor(householdDateTime(shiftPlainDate(range.to, 1)).getTime() / 1000)}`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

// Gmail operators, quotes or spaces in a stored sender would widen `from:`.
const LITERAL_SENDER =
  /^(?:[a-z0-9._%+-]+@)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/** A supporting expression cannot escape the host's parenthesized Vendor scope. */
export function isClosedMailSearch(query: string): boolean {
  if (query.includes("\\")) return false;
  if (/^(?:OR|AND)\b|\b(?:OR|AND)$/iu.test(query.trim())) return false;
  let quoted = false;
  const groups: string[] = [];
  for (const character of query) {
    if (character === '"') quoted = !quoted;
    else if (!quoted) {
      if (character === "(" || character === "{") groups.push(character);
      else if (
        (character === ")" && groups.pop() !== "(") ||
        (character === "}" && groups.pop() !== "{")
      )
        return false;
    }
  }
  return !quoted && groups.length === 0;
}

/** One literal sender or website-domain query per verified term. */
export function vendorMailQueries(
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
