import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor, type VendorId } from "@cubby/schemas/identifiers";
import type {
  DistinctFromVendor,
  PreparedVendorCandidate,
} from "@cubby/schemas/purchase-import";
import { arrayContains, and, eq, ilike, sql } from "drizzle-orm";

import {
  distinctSenderDomain,
  senderAddress,
  SHARED_SENDER_DOMAINS,
  SHARED_PLATFORM_DOMAINS,
  vendorWebsiteDomain,
} from "~/lib/vendor/domains";
import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { vendor } from "~/server/db/schema";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { resolveNames } from "~/server/entity-kernel/resolve";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { recordChange } from "~/server/generic/changes/repo/change";
import { matchesNameOrAlias } from "~/server/lib/name-alias-match";

type Db = Database | DrizzleTransaction;

export type ImportVendorInput = {
  name: string;
  sender: string | null;
  /** The order Email's external key, retained in research notes. */
  evidence: string | null;
  distinctFrom?: readonly DistinctFromVendor[];
};

const SIMILAR_NAME_REASON =
  "Similar Vendor name: reuse it by vendorId, or mark it distinctFrom with research notes.";
const SAME_DOMAIN_REASON =
  "Same website domain as the order Email's sender, shared by several Vendors.";

const words = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** One name is the other, or a whole-word run inside it, apart from punctuation. */
const similarName = (left: string, right: string) => {
  const [a, b] = [words(left), words(right)];
  if (!a || !b) return false;
  if (a.replaceAll(" ", "") === b.replaceAll(" ", "")) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && ` ${long} `.includes(` ${short} `);
};

/**
 * Existing Vendors an imported seller might be, strongest first: website
 * registrable domain equal to the sender's distinct domain, exact name or
 * alias, then a similar name or alias.
 */
export async function importVendorCandidates(
  db: Db,
  input: Pick<ImportVendorInput, "name" | "sender">,
) {
  const name = input.name.trim();
  const address = senderAddress(input.sender);
  const domain = address ? distinctSenderDomain(address) : null;
  const rows = await unwrapDb(db)
    .select({
      id: vendor.id,
      shortcode: vendor.shortcode,
      name: vendor.name,
      aliases: vendor.aliases,
      website: vendor.website,
    })
    .from(vendor)
    .where(notDeleted(vendor));
  return rows
    .map((row) => {
      const site = vendorWebsiteDomain(row.website);
      const known = [row.name, ...row.aliases];
      const candidate: PreparedVendorCandidate = {
        vendorId: parseShortcodeFor("vendor", row.shortcode),
        name: row.name,
        website: row.website,
        exactNameMatch: matchesNameOrAlias({
          name: row.name.trim(),
          aliases: row.aliases.map((value) => value.trim()),
          query: name,
        }),
        websiteDomainMatch:
          domain !== null &&
          site === domain &&
          !SHARED_SENDER_DOMAINS.has(site),
      };
      return {
        id: row.id,
        candidate,
        similar: known.some((value) => similarName(value, name)),
      };
    })
    .filter(
      ({ candidate, similar }) =>
        candidate.websiteDomainMatch || candidate.exactNameMatch || similar,
    )
    .sort(
      (a, b) =>
        Number(b.candidate.websiteDomainMatch) -
          Number(a.candidate.websiteDomainMatch) ||
        Number(b.candidate.exactNameMatch) -
          Number(a.candidate.exactNameMatch) ||
        a.candidate.name.localeCompare(b.candidate.name),
    )
    .slice(0, 20)
    .map(({ id, candidate }) => ({
      id,
      candidate: {
        ...candidate,
        ...(candidate.exactNameMatch
          ? {}
          : {
              matchReason: candidate.websiteDomainMatch
                ? SAME_DOMAIN_REASON
                : SIMILAR_NAME_REASON,
            }),
      },
    }));
}

/** Learn the order's merchant name as an alias of the Vendor its sender identifies. */
async function learnSenderAlias(
  db: Db,
  owner: { id: VendorId; name: string; aliases: string[] },
  input: { name: string; address: string; evidence: string | null },
  actor: ActorContext,
) {
  const { name, address } = input;
  if (matchesNameOrAlias({ ...owner, query: name })) return owner.id;
  // Sender identity never takes a name another Vendor already answers to: that
  // alias would make the name ambiguous (or misroute it) for every later lookup.
  const [named] = await resolveNames(db, "vendor", [{ name }], {
    create: false,
  });
  const others = named?.row ? [named.row, ...named.candidates] : [];
  if (others.length > 0)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `The order Email from ${address} identifies Vendor "${owner.name}", but the merchant name "${name}" belongs to ${others
        .map(({ shortcode }) => shortcode)
        .join(", ")}; name the order's vendorId explicitly.`,
    );
  const aliases = [...owner.aliases, name];
  const research = `Order Email ${input.evidence ?? "(unknown message)"} from ${address} names the merchant "${name}".`;
  await unwrapDb(db)
    .update(vendor)
    .set({
      aliases,
      notes: sql`concat_ws(E'\n\n', nullif(${vendor.notes}, ''), ${research}::text)`,
    })
    .where(eq(vendor.id, owner.id));
  await logAuditEntry(db, actor, {
    entityKind: "vendor",
    entityId: owner.id,
    action: "update",
    changes: {
      aliases: { from: owner.aliases, to: aliases },
      notes: { from: null, to: null },
    },
  });
  await recordChange(db, { kind: "source", categories: ["vendor"] });
  return owner.id;
}

/**
 * The Vendor a sender proves (terminology "Sender proof"): the one Vendor
 * recording the exact sender address, else, when none records it, the one
 * Vendor whose website registrable domain is the sender's distinct domain.
 * Reads only; null when the sender proves no single Vendor.
 */
export async function senderProofVendor(db: Db, sender: string | null) {
  const address = senderAddress(sender);
  if (!address) return null;
  // Platform addresses can represent unrelated sellers even when only one
  // Vendor currently records the address. Never learn merchant aliases from it.
  const senderDomain = vendorWebsiteDomain(
    `https://${address.split("@").at(-1)}`,
  );
  if (senderDomain && SHARED_PLATFORM_DOMAINS.has(senderDomain)) return null;
  const columns = {
    id: vendor.id,
    shortcode: vendor.shortcode,
    name: vendor.name,
    aliases: vendor.aliases,
  };
  const proven = await unwrapDb(db)
    .select(columns)
    .from(vendor)
    .where(
      and(
        notDeleted(vendor),
        arrayContains(vendor.orderEmailSenders, [address]),
      ),
    );
  if (proven.length > 1) return null;
  if (proven[0]) return { vendor: proven[0], address };
  const domain = distinctSenderDomain(address);
  if (!domain) return null;
  // SQL narrows to websites naming the domain; the registrable-domain match
  // stays in `vendorWebsiteDomain`, which SQL cannot reproduce. URL parsing
  // punycodes an internationalized website, so such a domain scans them all.
  const plainDomain = /^[a-z0-9.-]+$/u.test(domain) && !domain.includes("xn--");
  const sameDomain = (
    await unwrapDb(db)
      .select({ ...columns, website: vendor.website })
      .from(vendor)
      .where(
        plainDomain
          ? and(notDeleted(vendor), ilike(vendor.website, `%${domain}%`))
          : notDeleted(vendor),
      )
  ).filter((row) => vendorWebsiteDomain(row.website) === domain);
  const [only, ...others] = sameDomain;
  return only && !others.length
    ? {
        vendor: {
          id: only.id,
          shortcode: only.shortcode,
          name: only.name,
          aliases: only.aliases,
        },
        address,
      }
    : null;
}

/**
 * An imported order's Vendor (terminology "Sender proof", "Vendor alias"):
 * an exact sender address one Vendor records, else the one Vendor whose
 * website registrable domain is the sender's (a shared domain never counts),
 * each learning the merchant name as an alias with the Email in research notes;
 * else the exact name or alias. A new Vendor beside a same-domain or
 * similar-name candidate needs a sourced Distinct-from decision.
 */
export async function resolveImportVendor(
  db: Db,
  input: ImportVendorInput,
  actor: ActorContext,
): Promise<VendorId> {
  const name = input.name.trim();
  const proof = await senderProofVendor(db, input.sender);
  if (proof)
    return learnSenderAlias(
      db,
      proof.vendor,
      { name, address: proof.address, evidence: input.evidence },
      actor,
    );
  const candidates = await importVendorCandidates(db, input);
  const platformAlias = candidates.find(
    ({ candidate }) =>
      candidate.exactNameMatch &&
      candidate.name.toLowerCase() !== name.toLowerCase() &&
      SHARED_PLATFORM_DOMAINS.has(vendorWebsiteDomain(candidate.website) ?? ""),
  );
  if (platformAlias) {
    // Retain historical data, but do not let an alias learned by an older
    // sender-proof policy silently attribute another merchant to a platform.
    const canonical = candidates.filter(
      ({ candidate }) => candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (canonical.length === 1 && canonical[0]) return canonical[0].id;
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Seller "${name}" is recorded as an alias of shared platform ${platformAlias.candidate.vendorId}. Correct the historical Vendor alias and name the actual seller by vendorId before importing.`,
    );
  }
  if (candidates.some(({ candidate }) => candidate.exactNameMatch))
    return findOrCreateVendor(db, name);
  const cleared = new Set(
    (input.distinctFrom ?? []).map(({ vendorId }) => vendorId),
  );
  const unreviewed = candidates.filter(
    ({ candidate }) => !cleared.has(candidate.vendorId),
  );
  if (unreviewed.length > 0)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Vendor "${name}" resembles ${unreviewed
        .map(({ candidate }) => `${candidate.vendorId} ("${candidate.name}")`)
        .join(
          ", ",
        )}; name the order's vendorId, or mark each in vendor.distinctFrom with research notes showing the difference.`,
    );
  const created = await findOrCreateVendor(db, name);
  const research = (input.distinctFrom ?? [])
    .map(({ url, quote }) => [quote, url].filter(Boolean).join("\n"))
    .join("\n\n");
  if (research) {
    await unwrapDb(db)
      .update(vendor)
      .set({
        notes: sql`concat_ws(E'\n\n', nullif(${vendor.notes}, ''), ${research}::text)`,
      })
      .where(eq(vendor.id, created));
    await logAuditEntry(db, actor, {
      entityKind: "vendor",
      entityId: created,
      action: "update",
      changes: { notes: { from: null, to: null } },
    });
    await recordChange(db, { kind: "source", categories: ["vendor"] });
  }
  return created;
}
