import {
  browserPageCapture,
  type BrowserPageCapture,
  type BrowserPageSnapshot,
} from "@cubby/schemas/purchase-import";
import { decodeBase64Url, encodeBase64 } from "@cubby/shared/base64";
import { sha256Hex } from "@cubby/shared/sha256";

import { wasm } from "~/lib/wasm";

import { structuredProductsFromJsonLd } from "./structured-products";

/**
 * The server's reading of a captured page. Bump it when the derivation
 * changes: it is recorded on every capture (the field the Mac's own capture
 * version used to fill) and decides which stored pages a re-read refreshes.
 */
export const PAGE_DERIVATION_REVISION = 5;

const MAX_READABLE_TEXT = 24 * 1_024;
const MAX_LINKS = 200;
const MAX_IMAGES = 200;

type SnapshotDom = BrowserPageSnapshot["dom"];

async function transform(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
) {
  const body = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * A snapshot's DOM as text. Its checksum and size must match: a corrupt or
 * substituted payload is refused rather than read as some other page.
 */
export async function readSnapshotDom(dom: SnapshotDom): Promise<string> {
  const bytes = await transform(
    decodeBase64Url(dom.data),
    new DecompressionStream("deflate-raw"),
  );
  if (bytes.byteLength !== dom.byteSize || (await sha256Hex(bytes)) !== dom.sha256)
    throw new Error("Browser snapshot DOM does not match its checksum");
  return new TextDecoder().decode(bytes);
}

/** The inverse of `readSnapshotDom`, for fixtures and server-fetched pages. */
export async function encodeSnapshotDom(html: string): Promise<SnapshotDom> {
  const bytes = new TextEncoder().encode(html);
  return {
    encoding: "deflate-raw+base64",
    data: encodeBase64(
      await transform(bytes, new CompressionStream("deflate-raw")),
    ),
    byteSize: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    truncated: false,
  };
}

/**
 * Browser commands reach only ordinary HTTPS pages on an allowlisted host or
 * one of its subdomains (`notexample.com` never matches `example.com`), with
 * no credentials or fragment. The Mac enforces the same rule on every URL it
 * opens; the server applies it to every URL it hands back or derives.
 */
export function urlAllowed(raw: string, allowedHosts: readonly string[]) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    return false;
  const host = url.hostname.toLowerCase();
  return allowedHosts.some((allowed) => {
    const normalized = allowed.toLowerCase().replaceAll(/^\.+|\.+$/gu, "");
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

const amazonAsin = (raw: string | null) => {
  if (!raw) return null;
  try {
    const match = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/iu.exec(
      new URL(raw).pathname,
    );
    return match?.[1]?.toUpperCase() ?? null;
  } catch {
    return null;
  }
};

/**
 * Everything the old Mac capture computed, derived from the page's DOM. Exact
 * values (URLs, JSON-LD identifiers) are copied verbatim; links get ids the
 * server resolves itself when the agent follows one.
 */
export function derivePageCapture(input: {
  html: string;
  sourceURL: string;
  title: string;
  capturedAt: string;
  allowedHosts: readonly string[];
  /** The URL the run asked for, which can differ from the served one. */
  requestedURL: string | null;
  evidence: BrowserPageCapture["evidence"];
}): BrowserPageCapture {
  const page = wasm.compact_browser_page(input.html, input.sourceURL);
  const allowed = (url: string) => urlAllowed(url, input.allowedHosts);
  return browserPageCapture.parse({
    sourceURL: input.sourceURL,
    canonicalUrl:
      page.canonical_url && allowed(page.canonical_url)
        ? page.canonical_url
        : null,
    requestedAmazonAsin: amazonAsin(input.requestedURL),
    servedAmazonAsin: amazonAsin(input.sourceURL),
    variantMarkers: page.variant_markers
      .map((marker) => marker.slice(0, 500))
      .slice(0, 50),
    title: (input.title || page.title).slice(0, 500),
    capturedAt: input.capturedAt,
    captureVersion: PAGE_DERIVATION_REVISION,
    readableText: page.text.slice(0, MAX_READABLE_TEXT),
    links: page.links
      .filter((link) => allowed(link.href))
      .slice(0, MAX_LINKS)
      .map((link, index) => ({
        id: `link-${index + 1}`,
        url: link.href,
        label: link.text.slice(0, 300) || null,
      })),
    images: page.images
      .filter((image) => allowed(image.src))
      .slice(0, MAX_IMAGES)
      .map((image) => ({
        url: image.src,
        alt: image.alt.slice(0, 500) || null,
        naturalWidth: image.width ?? null,
        naturalHeight: image.height ?? null,
        highResolutionUrl:
          image.high_resolution && allowed(image.high_resolution)
            ? image.high_resolution
            : null,
      })),
    paymentEvidence: [],
    evidence: input.evidence,
    structuredProducts: structuredProductsFromJsonLd({
      pageURL: input.sourceURL,
      blocks: page.json_ld,
      omitted: page.json_ld_omitted,
    }),
    authenticationRequired: page.has_password_input,
  });
}
