import type { BrowserStructuredProducts } from "@cubby/schemas/purchase-import";
import { type JSONType, z } from "zod";

/**
 * What a server-side HTTP capture reads from a fetched vendor page: the same
 * schema.org walk the Mac browser's fixed capture script runs
 * (`MacBrowserCommandExecutor.captureScript`), over raw HTML instead of a DOM.
 * Only `application/ld+json` blocks are read for identity, never page text.
 */
export type ProductPageStructure = {
  canonicalUrl: string | null;
  structuredProducts: BrowserStructuredProducts;
  /** `image` URLs of the page's Product nodes, page-resolved, in order. */
  productImageUrls: string[];
  /** A password field: the page is a sign-in wall, not the product. */
  signInForm: boolean;
};

const MAX_BLOCKS = 20;
const MAX_BLOCK_CHARS = 512 * 1024;
const MAX_DEPTH = 8;
const MAX_NODES = 500;
const MAX_PRODUCTS = 20;
const MAX_VALUES = 10;
const MAX_IMAGES = 4;

const jsonArray = z.array(z.json());
const jsonObject = z.record(z.string(), z.json());
type JsonObject = z.infer<typeof jsonObject>;
const scalar = z.union([z.string(), z.number()]);
/** A schema.org `image`: a URL or an ImageObject naming one. */
const imageReference = z.union([
  z.string(),
  z.object({ contentUrl: z.string() }).transform((image) => image.contentUrl),
  z.object({ url: z.string() }).transform((image) => image.url),
]);

const listOf = (value: JSONType | undefined): JSONType[] =>
  value === undefined || value === null
    ? []
    : (jsonArray.safeParse(value).data ?? [value]);

const hasType = (node: JsonObject, name: string) =>
  listOf(node["@type"]).includes(name);

function values(node: JsonObject, keys: readonly string[]) {
  const out: string[] = [];
  for (const key of keys)
    for (const item of listOf(node[key])) {
      const parsed = scalar.safeParse(item);
      if (!parsed.success) continue;
      const text = String(parsed.data).replaceAll(/\s+/gu, " ").trim();
      if (text && !out.includes(text.slice(0, 100)))
        out.push(text.slice(0, 100));
    }
  return out.slice(0, MAX_VALUES);
}

function imageUrls(node: JsonObject, base: URL): string[] {
  const out: string[] = [];
  for (const item of listOf(node["image"])) {
    const raw = imageReference.safeParse(item);
    if (!raw.success) continue;
    try {
      const url = new URL(decodeEntities(raw.data), base);
      if (url.protocol === "https:" || url.protocol === "http:")
        out.push(url.href);
    } catch {
      // SILENT: a malformed image URL is not evidence; the rest still count.
    }
  }
  return out;
}

const ENTITIES = new Map([
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
  ["lt", "<"],
  ["gt", ">"],
]);

/** Attribute values only: decode the named and numeric references HTML allows. */
function decodeEntities(value: string) {
  return value.replaceAll(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/giu,
    (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x"))
        return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      if (lower.startsWith("#"))
        return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      return ENTITIES.get(lower) ?? match;
    },
  );
}

function attribute(tag: string, name: string) {
  const match = new RegExp(
    String.raw`\s${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`,
    "iu",
  ).exec(tag);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw === undefined ? null : decodeEntities(raw);
}

function canonicalUrl(html: string, base: URL) {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/giu)) {
    const rel = attribute(tag, "rel");
    if (!rel?.toLowerCase().split(/\s+/u).includes("canonical")) continue;
    const href = attribute(tag, "href");
    if (!href) return null;
    try {
      return new URL(href, base).href;
    } catch {
      return null;
    }
  }
  return null;
}

const WALKED_KEYS = [
  "@graph",
  "hasVariant",
  "mainEntity",
  "itemListElement",
  "item",
] as const;

/** Read one fetched page; `servedUrl` resolves its relative links. */
export function readProductPage(
  html: string,
  servedUrl: URL,
): ProductPageStructure {
  const products: BrowserStructuredProducts["products"] = [];
  const productImageUrls: string[] = [];
  let variantGroup = false;
  let visited = 0;
  const walk = (value: JSONType | undefined, depth: number) => {
    if (value === undefined || depth > MAX_DEPTH || ++visited > MAX_NODES)
      return;
    const array = jsonArray.safeParse(value);
    if (array.success) {
      for (const item of array.data) walk(item, depth + 1);
      return;
    }
    const node = jsonObject.safeParse(value);
    if (!node.success) return;
    if (hasType(node.data, "ProductGroup")) variantGroup = true;
    if (hasType(node.data, "Product")) {
      products.push({
        skus: values(node.data, ["sku"]),
        mpns: values(node.data, ["mpn"]),
        gtins: values(node.data, [
          "gtin",
          "gtin8",
          "gtin12",
          "gtin13",
          "gtin14",
        ]),
        productIds: values(node.data, ["productID"]),
      });
      productImageUrls.push(...imageUrls(node.data, servedUrl));
    }
    for (const key of WALKED_KEYS) walk(node.data[key], depth + 1);
  };
  const blocks = html.matchAll(
    /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/giu,
  );
  let read = 0;
  for (const [, raw = ""] of blocks) {
    if (++read > MAX_BLOCKS) break;
    if (raw.length > MAX_BLOCK_CHARS) continue;
    try {
      walk(z.json().parse(JSON.parse(raw)), 0);
    } catch {
      // SILENT: a malformed block proves nothing; the browser script skips it too.
    }
  }
  return {
    canonicalUrl: canonicalUrl(html, servedUrl),
    structuredProducts: {
      products: products.slice(0, MAX_PRODUCTS),
      variantGroup,
    },
    productImageUrls: [...new Set(productImageUrls)].slice(0, MAX_IMAGES),
    signInForm: /<input\b[^>]*\btype\s*=\s*["']?password\b/iu.test(html),
  };
}
