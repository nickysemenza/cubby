import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor, type VendorId } from "@cubby/schemas/identifiers";
import type {
  DistinctFromVendor,
  PreparedVendorCandidate,
} from "@cubby/schemas/purchase-import";
import { arrayContains, and, eq } from "drizzle-orm";

import {
  distinctSenderDomain,
  SHARED_SENDER_DOMAINS,
  vendorWebsiteDomain,
} from "~/lib/vendor/domains";
import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { vendor } from "~/server/db/schema";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { recordEntitySources } from "~/server/entity-kernel/repo/entity-source";
import { resolveNames } from "~/server/entity-kernel/resolve";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";

type Db = Database | DrizzleTransaction;

export type ImportVendorInput = {
  name: string;
  sender: string | null;
  /** The order Email's external key, quoted in recorded Sources. */
  evidence: string | null;
  distinctFrom?: readonly DistinctFromVendor[];
};

const SIMILAR_NAME_REASON =
  "Similar Vendor name: reuse it by vendorId, or mark it distinctFrom with a Source.";
const SAME_DOMAIN_REASON =
  "Same website domain as the order Email's sender, shared by several Vendors.";

/** The bare address of a From header such as `"Store" <orders@store.example>`. */
const senderAddress = (sender: string | null): string | null => {
  const address = (/<([^>]+)>/u.exec(sender ?? "")?.[1] ?? sender ?? "")
    .trim()
    .toLowerCase();
  return address.includes("@") ? address : null;
};

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
  const lower = name.toLowerCase();
  return rows
    .map((row) => {
      const site = vendorWebsiteDomain(row.website);
      const known = [row.name, ...row.aliases];
      const candidate: PreparedVendorCandidate = {
        vendorId: parseShortcodeFor("vendor", row.shortcode),
        name: row.name,
        website: row.website,
        exactNameMatch: known.some(
          (value) => value.trim().toLowerCase() === lower,
        ),
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
  const known = [owner.name, ...owner.aliases].map((value) =>
    value.toLowerCase(),
  );
  if (known.includes(name.toLowerCase())) return owner.id;
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
  await unwrapDb(db)
    .update(vendor)
    .set({ aliases })
    .where(eq(vendor.id, owner.id));
  await logAuditEntry(db, actor, {
    entityKind: "vendor",
    entityId: owner.id,
    action: "update",
    changes: { aliases: { from: owner.aliases, to: aliases } },
  });
  await recordEntitySources(db, {
    entityKind: "vendor",
    entityId: owner.id,
    sources: [
      {
        quote: `Order Email ${input.evidence ?? "(unknown message)"} from ${address} names the merchant "${name}".`,
      },
    ],
    recorder: actor,
  });
  return owner.id;
}

/**
 * An imported order's Vendor (terminology "Sender proof", "Vendor alias"):
 * an exact sender address one Vendor records, else the one Vendor whose
 * website registrable domain is the sender's (a shared domain never counts),
 * each learning the merchant name as an alias with the Email as its Source;
 * else the exact name or alias. A new Vendor beside a same-domain or
 * similar-name candidate needs a sourced Distinct-from decision.
 */
export async function resolveImportVendor(
  db: Db,
  input: ImportVendorInput,
  actor: ActorContext,
): Promise<VendorId> {
  const name = input.name.trim();
  const address = senderAddress(input.sender);
  const proven = address
    ? await unwrapDb(db)
        .select({ id: vendor.id, name: vendor.name, aliases: vendor.aliases })
        .from(vendor)
        .where(
          and(
            notDeleted(vendor),
            arrayContains(vendor.orderEmailSenders, [address]),
          ),
        )
    : [];
  if (address && proven.length === 1)
    return learnSenderAlias(
      db,
      proven[0]!,
      { name, address, evidence: input.evidence },
      actor,
    );
  const candidates = await importVendorCandidates(db, input);
  const sameDomain = candidates.filter(
    ({ candidate }) => candidate.websiteDomainMatch,
  );
  if (address && proven.length === 0 && sameDomain.length === 1) {
    const [owner] = await unwrapDb(db)
      .select({ id: vendor.id, name: vendor.name, aliases: vendor.aliases })
      .from(vendor)
      .where(eq(vendor.id, sameDomain[0]!.id));
    return learnSenderAlias(
      db,
      owner!,
      { name, address, evidence: input.evidence },
      actor,
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
        )}; name the order's vendorId, or mark each in vendor.distinctFrom with a Source showing the difference.`,
    );
  const created = await findOrCreateVendor(db, name);
  await recordEntitySources(db, {
    entityKind: "vendor",
    entityId: created,
    sources: (input.distinctFrom ?? []).map(({ url, quote }) => ({
      url,
      quote,
    })),
    recorder: actor,
  });
  return created;
}
