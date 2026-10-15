import { externalIdSource } from "@cubby/schemas/external-id";
import { eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { externalSource, vendor } from "~/server/db/schema";

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

type IdentifierSourceInput = {
  url?: string;
  vendorId?: typeof vendor.$inferSelect.id;
};
const issuerFields = {
  id: vendor.id,
  website: vendor.website,
  browserDomains: vendor.browserDomains,
};
type RegisteredSource = Pick<
  typeof externalSource.$inferSelect,
  "slug" | "vendorId"
>;
type IssuerRegistry = {
  vendors: Pick<
    typeof vendor.$inferSelect,
    "id" | "website" | "browserDomains"
  >[];
  sourcesByVendor: Map<string, RegisteredSource[]>;
  sourcesBySlug: Map<string, RegisteredSource>;
};

/** Resolve and register the issuer once for exact lookup, grouping and learning. */
async function productIdentifierSource(
  db: Database | DrizzleTransaction,
  input: IdentifierSourceInput,
  mode: { register: true } | { register: false; registry: IssuerRegistry },
): Promise<string | null> {
  const register = mode.register;
  const registry = mode.register ? undefined : mode.registry;
  const database = unwrapDb(db);
  const pageHost = input.url ? canonicalHost(input.url) : null;
  const vendors =
    registry?.vendors ??
    (await database
      .select(issuerFields)
      .from(vendor)
      .where(notDeleted(vendor)));
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
    const sources = registry
      ? (registry.sourcesByVendor.get(owner.id) ?? [])
      : await database
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
  if (register)
    await database
      .insert(externalSource)
      .values({ slug, label: issuerHost ?? slug, vendorId: owner?.id ?? null })
      .onConflictDoNothing();
  const registered = registry
    ? registry.sourcesBySlug.get(slug)
    : (
        await database
          .select()
          .from(externalSource)
          .where(eq(externalSource.slug, slug))
      )[0];
  if (!registered && !register) return null;
  if (!registered || registered.vendorId !== (owner?.id ?? null))
    throw new Error("Identifier issuer has incompatible source ownership.");
  return registered.slug;
}

/** Registry reads belong to one claim-loading operation; registration writes
 * always read current state and never use this read-only batch snapshot. */
export const lookupProductIdentifierSources = async (
  db: Database | DrizzleTransaction,
  inputs: readonly IdentifierSourceInput[],
) => {
  if (!inputs.length) return [];
  const database = unwrapDb(db);
  const [vendors, sources] = await Promise.all([
    database.select(issuerFields).from(vendor).where(notDeleted(vendor)),
    database
      .select({ slug: externalSource.slug, vendorId: externalSource.vendorId })
      .from(externalSource),
  ]);
  const registry: IssuerRegistry = {
    vendors,
    sourcesByVendor: new Map(),
    sourcesBySlug: new Map(),
  };
  for (const source of sources) {
    registry.sourcesBySlug.set(source.slug, source);
    if (source.vendorId) {
      const owned = registry.sourcesByVendor.get(source.vendorId) ?? [];
      owned.push(source);
      registry.sourcesByVendor.set(source.vendorId, owned);
    }
  }
  return Promise.all(
    inputs.map((input) =>
      productIdentifierSource(db, input, { register: false, registry }),
    ),
  );
};
export async function resolveProductIdentifierSource(
  db: Database | DrizzleTransaction,
  input: Parameters<typeof productIdentifierSource>[1],
): Promise<string> {
  const source = await productIdentifierSource(db, input, { register: true });
  if (!source)
    throw new Error("Identifier issuer registration returned no source");
  return source;
}
