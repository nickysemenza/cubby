import { externalIdSource } from "@cubby/schemas/external-id";
import type { VendorId } from "@cubby/schemas/identifiers";
import { getErrorMessage } from "@cubby/shared";
import { and, eq, inArray } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { externalSource, vendor } from "~/server/db/retained-tables";
import { createBlockedError } from "~/server/errors/app-error";

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
  shortcode: vendor.shortcode,
  website: vendor.website,
  browserDomains: vendor.browserDomains,
};
type RegisteredSource = Pick<
  typeof externalSource.$inferSelect,
  "slug" | "vendorId" | "issuer"
>;
type IssuerRegistry = {
  vendors: Pick<
    typeof vendor.$inferSelect,
    "id" | "shortcode" | "website" | "browserDomains"
  >[];
  issuersByVendor: Map<string, RegisteredSource>;
  sourcesBySlug: Map<string, RegisteredSource>;
};
const registeredFields = {
  slug: externalSource.slug,
  vendorId: externalSource.vendorId,
  issuer: externalSource.issuer,
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
    throw new Error(
      `Identifier issuer is ambiguous across canonical Vendors: ${owners
        .map((row) => row.shortcode)
        .join(", ")} all claim host ${pageHost}.`,
    );
  const owner = owners[0];
  if (!pageHost && !owner)
    throw new Error(
      "Identifier issuer requires a live canonical Vendor or page URL.",
    );
  if (owner) {
    // Export and settlement sources may share the Vendor; only the flagged
    // issuer names its Product identifiers.
    const issuer = registry
      ? registry.issuersByVendor.get(owner.id)
      : (
          await database
            .select(registeredFields)
            .from(externalSource)
            .where(
              and(
                eq(externalSource.vendorId, owner.id),
                eq(externalSource.issuer, true),
              ),
            )
        )[0];
    if (issuer) return issuer.slug;
  }
  const issuerHost = owner ? (issuerDomains(owner)[0] ?? pageHost) : pageHost;
  const slug = issuerHost
    ? hostSource(issuerHost)
    : externalIdSource.parse(`vendor-${owner!.id}`);
  // Register with explicit ownership; ensureExternalSources' name matching is
  // not authority for a retained page. An existing row keeps its owner.
  if (register) {
    await database
      .insert(externalSource)
      .values({
        slug,
        label: issuerHost ?? slug,
        vendorId: owner?.id ?? null,
        issuer: Boolean(owner),
      })
      .onConflictDoNothing();
    if (owner)
      await database
        .update(externalSource)
        .set({ issuer: true })
        .where(
          and(
            eq(externalSource.slug, slug),
            eq(externalSource.vendorId, owner.id),
          ),
        );
  }
  const registered = registry
    ? registry.sourcesBySlug.get(slug)
    : (
        await database
          .select(registeredFields)
          .from(externalSource)
          .where(eq(externalSource.slug, slug))
      )[0];
  if (!registered && !register) return null;
  if (!registered || registered.vendorId !== (owner?.id ?? null))
    throw new Error(
      `Identifier issuer has incompatible source ownership: ${slug} is registered to ${
        registered?.vendorId
          ? (vendors.find((row) => row.id === registered.vendorId)?.shortcode ??
            "a deleted Vendor")
          : "no Vendor"
      }, not ${owner?.shortcode ?? "an unowned host"}.`,
    );
  return registered.slug;
}

export type IdentifierSourceLookup =
  | { source: string | null; error: null }
  | { source: null; error: string };

/** Registry reads belong to one claim-loading operation; registration writes
 * always read current state and never use this read-only batch snapshot.
 * Each input resolves independently: one unresolvable issuer must not hide the
 * rest of the catalog from exact lookup. */
export const lookupProductIdentifierSources = async (
  db: Database | DrizzleTransaction,
  inputs: readonly IdentifierSourceInput[],
): Promise<IdentifierSourceLookup[]> => {
  if (!inputs.length) return [];
  const database = unwrapDb(db);
  const [vendors, sources] = await Promise.all([
    database.select(issuerFields).from(vendor).where(notDeleted(vendor)),
    database.select(registeredFields).from(externalSource),
  ]);
  const registry: IssuerRegistry = {
    vendors,
    issuersByVendor: new Map(),
    sourcesBySlug: new Map(),
  };
  for (const source of sources) {
    registry.sourcesBySlug.set(source.slug, source);
    if (source.vendorId && source.issuer)
      registry.issuersByVendor.set(source.vendorId, source);
  }
  return Promise.all(
    inputs.map(async (input) => {
      try {
        return {
          source: await productIdentifierSource(db, input, {
            register: false,
            registry,
          }),
          error: null,
        };
      } catch (error) {
        return { source: null, error: getErrorMessage(error) };
      }
    }),
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

/** A Vendor merge repoints every source; two issuers would leave the survivor
 * with two namespaces for one catalog, so the member reconciles them first. */
export async function repointVendorIdentifierSources(
  tx: DrizzleTransaction,
  input: { keepId: VendorId; loserIds: readonly VendorId[] },
) {
  const database = unwrapDb(tx);
  const issuers = await database
    .select({ slug: externalSource.slug, vendor: vendor.shortcode })
    .from(externalSource)
    .innerJoin(vendor, eq(vendor.id, externalSource.vendorId))
    .where(
      and(
        inArray(externalSource.vendorId, [input.keepId, ...input.loserIds]),
        eq(externalSource.issuer, true),
      ),
    )
    .orderBy(externalSource.slug);
  if (issuers.length > 1)
    throw createBlockedError(
      "ENTITY_DELETE_BLOCKED",
      `Cannot merge vendor: each Vendor issues Product identifiers under its own source (${issuers
        .map((row) => `${row.vendor}: ${row.slug}`)
        .join(
          ", ",
        )}). Move one Vendor's Product identifiers to the other issuer and clear its issuer flag before merging.`,
      [],
    );
  if (input.loserIds.length)
    await database
      .update(externalSource)
      .set({ vendorId: input.keepId })
      .where(inArray(externalSource.vendorId, [...input.loserIds]));
}
