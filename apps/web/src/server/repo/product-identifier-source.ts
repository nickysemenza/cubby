import { externalIdSource } from "@cubby/schemas/external-id";
import { eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { externalSource, vendor } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

const canonicalHost = (url: string) => {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname)
    throw new Error("Identifier issuer requires an HTTP page host.");
  return parsed.hostname
    .toLowerCase()
    .replace(/^www\./u, "")
    .replace(/\.$/u, "");
};
const domainHost = (domain: string) => canonicalHost(`https://${domain}`);
const belongsTo = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);
const issuerDomains = (
  issuer: Pick<typeof vendor.$inferSelect, "website" | "browserDomains">,
) => [
  ...(issuer.website ? [canonicalHost(issuer.website)] : []),
  ...issuer.browserDomains.map(domainHost),
];

// Full-host bytes are reversible and preserve dots and hyphens, unlike a
// name slug. Legacy prefix/name registrations never establish domain authority.
const hostSource = (host: string) =>
  externalIdSource.parse(
    `host-${Array.from(new TextEncoder().encode(host), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`,
  );

/** Resolve and register the issuer once for exact lookup, grouping and learning. */
export async function resolveProductIdentifierSource(
  db: Database | DrizzleTransaction,
  input: {
    url?: string;
    vendorId?: typeof vendor.$inferSelect.id;
  },
): Promise<string> {
  const database = unwrapDb(db);
  const pageHost = input.url ? canonicalHost(input.url) : null;
  const vendors = await database
    .select({
      id: vendor.id,
      website: vendor.website,
      browserDomains: vendor.browserDomains,
    })
    .from(vendor)
    .where(notDeleted(vendor));
  const owners = pageHost
    ? vendors.filter((row) =>
        issuerDomains(row).some((domain) => belongsTo(pageHost, domain)),
      )
    : vendors.filter((row) => row.id === input.vendorId);
  if (owners.length > 1)
    throw new Error("Identifier issuer is ambiguous across canonical Vendors.");
  const owner = owners[0];
  if (!pageHost && !owner)
    throw new Error(
      "Identifier issuer requires a live canonical Vendor or page URL.",
    );
  if (owner) {
    const sources = await database
      .select()
      .from(externalSource)
      .where(eq(externalSource.vendorId, owner.id));
    if (sources.length > 1)
      throw new Error(
        "Identifier issuer has competing canonical source registrations.",
      );
    if (sources[0]) return sources[0].slug;
  }
  const issuerHost = owner ? (issuerDomains(owner)[0] ?? pageHost) : pageHost;
  const slug = issuerHost
    ? hostSource(issuerHost)
    : externalIdSource.parse(`vendor-${owner!.id}`);
  // Register with explicit ownership; ensureExternalSources' name matching is
  // not authority for a retained page. Never change an existing registry row.
  await database
    .insert(externalSource)
    .values({ slug, label: issuerHost ?? slug, vendorId: owner?.id ?? null })
    .onConflictDoNothing();
  const [registered] = await database
    .select()
    .from(externalSource)
    .where(eq(externalSource.slug, slug));
  if (!registered || registered.vendorId !== (owner?.id ?? null))
    throw new Error("Identifier issuer has incompatible source ownership.");
  return registered.slug;
}
