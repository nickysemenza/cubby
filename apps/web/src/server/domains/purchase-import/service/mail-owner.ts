/**
 * Who owns the mailbox a retained Email sits in, and the one attribution the
 * host decides without a model: a vendor writing directly to the owner.
 */
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";

type MailParty = { name: string; addresses: readonly string[] };

/** The Email's owner LedgerParty and the household's other live members. */
export type MailOwnerEvidence = {
  owner: MailParty;
  householdMembers: readonly MailParty[];
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

const ADDRESS = /[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]]+\.[^\s<>,;:"()[\]]+/gu;

/** Normalized addresses named in an addressing header value. */
function headerAddresses(value: string | undefined): Set<string> {
  const found = new Set<string>();
  for (const match of value?.match(ADDRESS) ?? []) {
    const normalized = normalizeMailAddress(match);
    if (normalized) found.add(normalized);
  }
  return found;
}

// Any of these means the copy travelled through another mailbox first.
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-to",
  "x-google-original-from",
  "resent-from",
  "resent-to",
  "resent-sender",
  "resent-date",
] as const;
const FORWARDED_SUBJECT = /^\s*(?:re:\s*)*(?:fwd?|fw)\s*:/iu;
const FORWARDED_BODY =
  /-{2,}\s*forwarded message\s*-{2,}|^\s*begin forwarded message:/imu;

type OwnMailInput = Pick<RetainedMail, "sender" | "subject" | "content">;

/**
 * Deterministic `recipient`: the owner is a To recipient, the sender is
 * neither the owner nor a household member, and nothing marks the copy as
 * forwarded. Delivered-To alone does not qualify — Gmail stamps it on Cc and
 * Bcc copies too — and household senders still need the model, since a
 * member may be sharing their own purchase.
 */
export function ownMailAttribution(
  mail: OwnMailInput,
  evidence: MailOwnerEvidence | null,
): "recipient" | null {
  if (!evidence) return null;
  const owner = addressSet([evidence.owner]);
  if (!owner.size) return null;
  const headers = mail.content.headers ?? {};
  if (FORWARDING_HEADERS.some((name) => headers[name]?.trim())) return null;
  if (FORWARDED_SUBJECT.test(mail.subject ?? "")) return null;
  if (FORWARDED_BODY.test(mail.content.bodyText ?? "")) return null;
  const to = headerAddresses(headers.to);
  if (![...to].some((address) => owner.has(address))) return null;
  const senders = new Set([
    ...headerAddresses(headers.from),
    ...headerAddresses(headers.sender),
    ...headerAddresses(mail.sender ?? undefined),
  ]);
  if (!senders.size) return null;
  const household = addressSet([evidence.owner, ...evidence.householdMembers]);
  if ([...senders].some((address) => household.has(address))) return null;
  return "recipient";
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
