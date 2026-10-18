/**
 * Who owns the mailbox a retained Email sits in, and which Emails are a
 * vendor writing directly to that owner.
 */
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";

type MailParty = { name: string; addresses: readonly string[] };

/** The Email's owner LedgerParty and the household's other live members. */
export type MailOwnerEvidence = {
  owner: MailParty;
  householdMembers: readonly MailParty[];
};

/** Owner evidence and the gaps in it, e.g. an unreadable Gmail profile. */
export type MailOwnerContext = {
  evidence: MailOwnerEvidence | null;
  warnings: readonly string[];
};

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Comparable mailbox identity: lowercase, `+tag` removed; Gmail also ignores
 * dots in the local part and treats googlemail.com as gmail.com.
 */
export function normalizeMailAddress(address: string): string | null {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  local = local.split("+")[0] ?? "";
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  return local ? `${local}@${domain}` : null;
}

/**
 * Normalized addr-specs in an addressing header value. Only the address
 * inside `<…>` counts when present; quoted display names, comments and group
 * labels never do, so `"owner@x" <friend@y>` names only friend@y.
 */
function headerAddresses(value: string | undefined): Set<string> {
  const found = new Set<string>();
  for (const mailbox of withoutQuotesAndComments(value ?? "").split(/[,;]/u)) {
    const angle = /<([^<>]*)>/u.exec(mailbox);
    // A group label (`Team: a@b`) precedes its first member.
    const spec = (angle ? angle[1]! : mailbox.replace(/^[^:@]*:/u, "")).trim();
    if (/\s/u.test(spec)) continue;
    const normalized = normalizeMailAddress(spec);
    if (normalized) found.add(normalized);
  }
  return found;
}

/**
 * The header with quoted strings and (nested) comments blanked, honouring
 * backslash escapes, so neither can contribute a recipient.
 */
function withoutQuotesAndComments(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === "\\" && (quoted || depth > 0)) {
      index++;
      continue;
    }
    if (quoted) {
      if (char === '"') quoted = false;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")" && depth > 0) depth--;
    else if (depth === 0) {
      if (char === '"') quoted = true;
      else out += char;
      continue;
    }
    out += " ";
  }
  return out;
}

// Any of these means the copy travelled through another mailbox first.
const isForwardingHeader = (name: string) => {
  const key = name.toLowerCase();
  return (
    key.startsWith("x-forwarded-") ||
    key.startsWith("resent-") ||
    key === "x-google-original-from"
  );
};
const FORWARDED_SUBJECT = /^\s*(?:re:\s*)*(?:fwd?|fw)\s*:/iu;
const FORWARDED_BODY =
  /-{2,}\s*forwarded message\s*-{2,}|^\s*begin forwarded message:/imu;

type OwnMailInput = Pick<RetainedMail, "sender" | "subject" | "content">;

/**
 * Own mail: the owner is a To recipient, the sender is neither the owner nor
 * a household member, and nothing marks the copy as forwarded. Its
 * attribution defaults to `recipient` unless the model confidently names a
 * third party. Delivered-To alone does not qualify — Gmail stamps it on Cc
 * and Bcc copies too — and household senders keep the ordinary judgment,
 * since a member may be sharing their own purchase. `htmlText` is the
 * compact text of the HTML body, so HTML-only forwards are seen too.
 */
export function isOwnMail(
  mail: OwnMailInput,
  evidence: MailOwnerEvidence | null,
  htmlText: string | null,
): boolean {
  if (!evidence) return false;
  const owner = addressSet([evidence.owner]);
  if (!owner.size) return false;
  const headers = mail.content.headers ?? {};
  if (
    Object.entries(headers).some(
      ([name, value]) => isForwardingHeader(name) && value.trim(),
    )
  )
    return false;
  if (FORWARDED_SUBJECT.test(mail.subject ?? "")) return false;
  if (
    FORWARDED_BODY.test(mail.content.bodyText ?? "") ||
    FORWARDED_BODY.test(htmlText ?? "")
  )
    return false;
  const to = headerAddresses(headers.to);
  if (![...to].some((address) => owner.has(address))) return false;
  const senders = new Set([
    ...headerAddresses(headers.from),
    ...headerAddresses(headers.sender),
    ...headerAddresses(mail.sender ?? undefined),
  ]);
  if (!senders.size) return false;
  const household = addressSet([evidence.owner, ...evidence.householdMembers]);
  return ![...senders].some((address) => household.has(address));
}

function addressSet(parties: readonly MailParty[]): Set<string> {
  return new Set(
    parties.flatMap((party) =>
      party.addresses.flatMap((address) => {
        const normalized = normalizeMailAddress(address);
        return normalized ? [normalized] : [];
      }),
    ),
  );
}
