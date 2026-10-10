import type { BrowserStructuredProducts } from "@cubby/schemas/purchase-import";
import { z } from "zod";

/**
 * schema.org Product identifiers from a page's raw JSON-LD blocks, read
 * verbatim (never from page text): the input to the single-Product proof in
 * `structured-identifier-proof.ts`. Every bound fails closed: anything left
 * unread marks the page a variant group, never one exact Product.
 */
type Identifiers = {
  skus: string[];
  mpns: string[];
  gtins: string[];
  productIds: string[];
};
const FIELDS = ["skus", "mpns", "gtins", "productIds"] as const;

const MAX_VALUES = 10;
const MAX_VALUE_LENGTH = 100;
const MAX_PRODUCTS = 20;
const MAX_OFFERS = 100;
const MAX_DEPTH = 8;
const MAX_NODES = 500;
const OFFER_BUDGET = 1_000;

const jsonValue = z.json();
type Json = z.infer<typeof jsonValue>;
type JsonNode = { [key: string]: Json };
const scalar = z.union([z.string(), z.number()]);
const asRecord = (value: Json | undefined): JsonNode | null =>
  value instanceof Object && !Array.isArray(value) ? value : null;
const asArray = (value: Json | undefined): Json[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value];
const clean = (value: string | number) =>
  String(value).replaceAll(/\s+/gu, " ").trim();

/** A repeated, empty, or undecodable `?variant=`: never matches anything. */
const INVALID = Symbol("invalid variant");
type Variant = string | null | typeof INVALID;

/**
 * Shopify-style `?variant=<id>`: only the query component counts, names and
 * values are decoded, and anything but exactly one non-empty value is invalid.
 */
function variantOf(url: Json | undefined): Variant {
  const beforeFragment = String(url ?? "").split("#")[0] ?? "";
  const start = beforeFragment.indexOf("?");
  if (start < 0) return null;
  const found: string[] = [];
  for (const pair of beforeFragment.slice(start + 1).split("&")) {
    const equals = pair.indexOf("=");
    const decode = (text: string) =>
      decodeURIComponent(text.replaceAll("+", " "));
    let name: string;
    let value: string;
    try {
      name = decode(equals < 0 ? pair : pair.slice(0, equals));
      value = decode(equals < 0 ? "" : pair.slice(equals + 1));
    } catch {
      return INVALID;
    }
    if (name === "variant") found.push(value);
  }
  if (found.length === 0) return null;
  return found.length === 1 && found[0] ? found[0] : INVALID;
}

export function structuredProductsFromJsonLd(input: {
  /** The URL the page was served at; its `?variant=` names the shown variant. */
  pageURL: string;
  blocks: readonly string[];
  /** Blocks the compactor left out; any makes the data incomplete. */
  omitted: number;
}): BrowserStructuredProducts {
  let truncated = input.omitted > 0;
  const values = (node: JsonNode, keys: readonly string[]) => {
    const out: string[] = [];
    for (const key of keys) {
      for (const item of asArray(node[key])) {
        const parsed = scalar.safeParse(item);
        if (!parsed.success) continue;
        const full = clean(parsed.data);
        // A clipped identifier could equal another variant's; never compare prefixes.
        if (full.length > MAX_VALUE_LENGTH) truncated = true;
        const text = full.slice(0, MAX_VALUE_LENGTH);
        if (text && !out.includes(text)) out.push(text);
      }
    }
    if (out.length > MAX_VALUES) truncated = true;
    return out.slice(0, MAX_VALUES);
  };
  const hasType = (node: JsonNode, name: string) =>
    asArray(node["@type"]).includes(name);
  const identifiers = (node: JsonNode): Identifiers => ({
    skus: values(node, ["sku"]),
    mpns: values(node, ["mpn"]),
    gtins: values(node, ["gtin", "gtin8", "gtin12", "gtin13", "gtin14"]),
    productIds: values(node, ["productID"]),
  });
  const merge = (...sets: Identifiers[]): Identifiers => {
    const out: Identifiers = { skus: [], mpns: [], gtins: [], productIds: [] };
    for (const set of sets)
      for (const key of FIELDS)
        for (const item of set[key])
          if (!out[key].includes(item)) out[key].push(item);
    for (const key of FIELDS) {
      if (out[key].length > MAX_VALUES) truncated = true;
      out[key] = out[key].slice(0, MAX_VALUES);
    }
    return out;
  };
  const sameList = (left: string[], right: string[]) =>
    left.length === right.length && left.every((item) => right.includes(item));
  const sameSet = (left: Identifiers, right: Identifiers) =>
    FIELDS.every((key) => sameList(left[key], right[key]));
  const conflicts = (left: string[], right: string[]) =>
    left.length > 0 && right.length > 0 && !sameList(left, right);

  const servedVariant = variantOf(input.pageURL);
  const products: Identifiers[] = [];
  let variantGroup = false;
  // Offers have their own budget so a long offer list cannot starve the walk.
  let visited = 0;
  let offerBudget = OFFER_BUDGET;

  const collectOffers = (product: JsonNode) => {
    const offers: JsonNode[] = [];
    for (const raw of asArray(product.offers)) {
      const offerNode = asRecord(raw);
      if (!offerNode) continue;
      const nested =
        asRecord(offerNode.offers) || Array.isArray(offerNode.offers)
          ? asArray(offerNode.offers)
          : [offerNode];
      for (const candidate of nested) {
        const item = asRecord(candidate);
        if (!item) continue;
        if (offers.length >= MAX_OFFERS || --offerBudget < 0) {
          truncated = true;
          return offers;
        }
        offers.push(item);
      }
    }
    return offers;
  };

  // Per-variant identifiers live in a Product's `offers`. Never choose
  // between variants: Product and Offers merge only when they agree, and
  // otherwise only the one Offer whose `?variant=` is the served page's own
  // variant may stand for the page.
  const productIdentifiers = (product: JsonNode): Identifiers => {
    const own = identifiers(product);
    const offers = collectOffers(product);
    if (offers.length === 0) return own;
    if (servedVariant === INVALID) {
      variantGroup = true;
      return own;
    }
    const offerSets = offers.map(identifiers);
    const offerVariants = offers.map((item): Variant => {
      if (servedVariant && item.url !== undefined) {
        try {
          const served = new URL(input.pageURL);
          const offered = new URL(String(item.url), served);
          // Variant ids are local to the product page, not global identities.
          if (
            offered.protocol !== "https:" ||
            offered.username ||
            offered.password ||
            offered.origin !== served.origin ||
            offered.pathname !== served.pathname
          )
            return INVALID;
        } catch {
          return INVALID;
        }
      }
      return variantOf(item.url);
    });
    const first = offerSets[0]!;
    const agree =
      offerSets.every((set) => sameSet(set, first)) &&
      !conflicts(own.skus, first.skus) &&
      !conflicts(own.gtins, first.gtins) &&
      !(
        servedVariant &&
        offerVariants.some(
          (variant) => variant !== null && variant !== servedVariant,
        )
      );
    if (agree) return merge(own, first);
    const served = servedVariant
      ? offerVariants.flatMap((variant, index) =>
          variant === servedVariant ? [index] : [],
        )
      : [];
    if (served.length !== 1) {
      variantGroup = true;
      return own;
    }
    // Product-level sku/gtin describe the default variant, not the served one.
    return merge(
      { skus: [], mpns: own.mpns, gtins: [], productIds: own.productIds },
      offerSets[served[0]!]!,
    );
  };

  const walk = (value: Json | undefined, depth: number): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      if (depth > MAX_DEPTH || ++visited > MAX_NODES) {
        truncated = true;
        return;
      }
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const node = asRecord(value);
    if (!node) return;
    if (depth > MAX_DEPTH || ++visited > MAX_NODES) {
      truncated = true;
      return;
    }
    if (hasType(node, "ProductGroup")) variantGroup = true;
    if (hasType(node, "Product")) products.push(productIdentifiers(node));
    for (const key of [
      "@graph",
      "hasVariant",
      "mainEntity",
      "itemListElement",
      "item",
    ])
      walk(node[key], depth + 1);
  };

  for (const raw of input.blocks) {
    let parsed: Json | undefined;
    try {
      parsed = jsonValue.parse(JSON.parse(raw));
    } catch {
      // SILENT: pages often carry malformed JSON-LD next to valid blocks; an
      // unreadable block contributes no identifiers rather than failing the page.
      continue;
    }
    walk(parsed, 0);
  }
  if (products.length > MAX_PRODUCTS) truncated = true;
  return {
    products: products.slice(0, MAX_PRODUCTS),
    variantGroup: variantGroup || truncated,
  };
}
