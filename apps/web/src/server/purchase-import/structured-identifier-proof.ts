import {
  GTIN_KIND,
  GTIN_SOURCE,
  manufacturerSource,
  normalizeGtin,
  type ExternalIdKind,
} from "@cubby/schemas/external-id";
import type { BrowserStructuredProducts } from "@cubby/schemas/purchase-import";

/** The retained browser-capture metadata this proof reads. */
export type StructuredPageEvidence = {
  sourceURL?: string;
  canonicalUrl?: string | null;
  structuredProducts?: BrowserStructuredProducts | null;
};

export type ProvableIdentifier = {
  source: string;
  kind: string;
  externalId: string;
};

/** What the proof needs to know about the Product that would own the identifier. */
export type ProofProduct = { manufacturer?: string | null };

export type IdentifierProof =
  | { proven: true; externalId: string }
  | { proven: false; reason: string };

const hostOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return null;
  }
};

const normalizedDomain = (domain: string) =>
  domain.toLowerCase().replace(/^www\./u, "");

const hostBelongsTo = (host: string, domains: readonly string[]) =>
  domains.some((domain) => {
    const allowed = normalizedDomain(domain);
    return host === allowed || host.endsWith(`.${allowed}`);
  });

const slugOfHost = (host: string): string =>
  host
    .split(".")[0]
    ?.replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "") ?? "";

const MANUFACTURER_PART_KIND = "manufacturer_part" satisfies ExternalIdKind;

type StructuredField = "skus" | "mpns" | "productIds";

/** The structured fields a kind may be proven from; a kind not listed is not provable here. */
function fieldsFor(kind: string): readonly StructuredField[] | null {
  switch (kind) {
    case "retailer_sku":
      return ["skus"];
    case "item_number":
      return ["skus", "productIds"];
    case "internet_number":
      return ["productIds", "skus"];
    case "catalog_number":
      return ["mpns", "skus"];
    case "manufacturer_part":
      // Never `skus`: those are the seller's, and a seller SKU is not a part number.
      return ["mpns"];
    default:
      return null;
  }
}

const comparable = (value: string) => value.trim().toLowerCase();

/** A manufacturer part belongs to the Product's maker; every other kind to the page vendor. */
function sourceOwnsIdentifier(
  identifier: ProvableIdentifier,
  host: string,
  allowedDomains: readonly string[],
  owner: ProofProduct,
): { proven: true } | { proven: false; reason: string } {
  if (identifier.kind === MANUFACTURER_PART_KIND) {
    const makerSlug = owner.manufacturer
      ? manufacturerSource(owner.manufacturer)
      : null;
    return makerSlug && identifier.source === makerSlug
      ? { proven: true }
      : { proven: false, reason: "source is not the Product's manufacturer" };
  }
  const domainSlugs = new Set([
    slugOfHost(host),
    ...allowedDomains
      .filter((domain) => hostBelongsTo(host, [domain]))
      .map((domain) => slugOfHost(normalizedDomain(domain))),
  ]);
  return domainSlugs.has(identifier.source)
    ? { proven: true }
    : { proven: false, reason: "source is not the page vendor" };
}

/**
 * Whether a single page's retained structured data proves one identifier for
 * the exact variant it shows.
 *
 * Constraints, all required:
 * - the served page and its canonical URL stay on the run vendor's browser
 *   domains (a redirect off-vendor proves nothing),
 * - the identifier's source is the vendor slug the purchase importer derives
 *   from that host (GTIN keeps its retailer-agnostic source but still needs
 *   the vendor page; `manufacturer_part` instead needs the slug of the
 *   Product's own manufacturer, since the part number belongs to the maker),
 * - exactly one schema.org Product node and no ProductGroup: with several
 *   variants the page does not say which one the identifier names,
 * - that node's matching field equals the identifier after normalization.
 *
 * Amazon ASINs use their own requested-vs-served proof, not this function.
 */
export function proveStructuredIdentifier(
  identifier: ProvableIdentifier,
  page: StructuredPageEvidence,
  allowedDomains: readonly string[],
  owner: ProofProduct = {},
): IdentifierProof {
  const structured = page.structuredProducts;
  if (!structured)
    return { proven: false, reason: "capture has no structured product data" };
  const host = hostOf(page.sourceURL);
  if (!host || !hostBelongsTo(host, allowedDomains))
    return { proven: false, reason: "served page is not on the vendor domain" };
  if (page.canonicalUrl) {
    const canonicalHost = hostOf(page.canonicalUrl);
    if (!canonicalHost || !hostBelongsTo(canonicalHost, allowedDomains))
      return { proven: false, reason: "canonical URL is off the vendor" };
  }
  if (structured.variantGroup || structured.products.length !== 1)
    return {
      proven: false,
      reason: "page does not expose exactly one Product variant",
    };
  const [productNode] = structured.products;
  if (!productNode) return { proven: false, reason: "no Product node" };

  if (identifier.kind === GTIN_KIND) {
    if (identifier.source !== GTIN_SOURCE)
      return { proven: false, reason: "GTIN identifiers use the gtin source" };
    const wanted = normalizeGtin(identifier.externalId.trim());
    if (!wanted) return { proven: false, reason: "invalid GTIN" };
    return productNode.gtins.some((value) => normalizeGtin(value) === wanted)
      ? { proven: true, externalId: wanted }
      : { proven: false, reason: "page Product has a different GTIN" };
  }

  const fields = fieldsFor(identifier.kind);
  if (!fields)
    return { proven: false, reason: "identifier kind has no structured proof" };
  const sourceProof = sourceOwnsIdentifier(
    identifier,
    host,
    allowedDomains,
    owner,
  );
  if (!sourceProof.proven) return sourceProof;
  const wanted = comparable(identifier.externalId);
  if (!wanted) return { proven: false, reason: "empty identifier" };
  for (const field of fields) {
    const match = productNode[field].find(
      (value) => comparable(value) === wanted,
    );
    if (match) return { proven: true, externalId: match.trim() };
  }
  return { proven: false, reason: "page Product has a different identifier" };
}

/**
 * A page proves the exact variant for a catalog image when it proves at least
 * one identifier the Product already carries or is committing.
 */
export function structuredPageProvesExactVariant(
  candidates: readonly ProvableIdentifier[],
  page: StructuredPageEvidence,
  allowedDomains: readonly string[],
  owner: ProofProduct = {},
): boolean {
  return candidates.some(
    (candidate) =>
      proveStructuredIdentifier(candidate, page, allowedDomains, owner).proven,
  );
}
