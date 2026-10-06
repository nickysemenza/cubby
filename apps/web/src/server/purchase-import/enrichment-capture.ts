import type { ActorContext } from "@cubby/schemas/context";
import { ALLOWED_IMAGE_TYPES } from "@cubby/schemas/image";
import {
  browserStructuredProducts,
  captureEnrichmentPageInput,
  captureEnrichmentPageOut,
} from "@cubby/schemas/purchase-import";
import {
  assertResponseContentType,
  fetchExternalResponse,
  MAX_EXTERNAL_HTML_BYTES,
  readResponseWithLimit,
  validateExternalHttpUrl,
} from "@cubby/shared/external-fetch";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import type { Database } from "~/server/db";
import { run as runTable, runEvidence, runTarget } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { inspectImageFile } from "~/server/services/image-integrity";
import { deleteS3Object, uploadToS3 } from "~/server/utils/s3";

import { assertCallerRunActive, loadCallerRun } from "./caller-enrichment";
import { readProductPage } from "./product-page-structure";
import { isVendorBrowserUrl } from "./targeted-run";

const PAGE_TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 10_000;
/** One catalog image is evidence of dimensions and bytes, not an archive. */
const MAX_CAPTURE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * What an `http_capture` retains in `RunEvidence.sourceMetadata`. Every field
 * is derived by the server from bytes it fetched itself, never supplied by
 * the caller; the commit writer reads the same shape as a browser capture's,
 * plus each image's SHA-256 so the stored cover must be those exact bytes.
 */
const httpCaptureMetadata = z.object({
  captureVersion: z.literal(1),
  requestedUrl: z.url(),
  sourceURL: z.url(),
  canonicalUrl: z.url().nullable(),
  structuredProducts: browserStructuredProducts,
  requestedAmazonAsin: z.null(),
  servedAmazonAsin: z.null(),
  variantMarkers: z.array(z.string()),
  images: z.array(
    z.object({
      url: z.url(),
      naturalWidth: z.number().int().positive(),
      naturalHeight: z.number().int().positive(),
      highResolutionUrl: z.null(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  ),
});
type HttpCaptureMetadata = z.infer<typeof httpCaptureMetadata>;

/** A page the server will not retain as proof; the caller reads why. */
class CaptureRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureRefusal";
  }
}

const offVendor = (url: URL, allowedHosts: readonly string[]) =>
  new CaptureRefusal(
    `${url.hostname} is not on the run vendor's browser domains (${allowedHosts.join(", ") || "none"})`,
  );

/**
 * Fetch the page, refusing any hop off the vendor: the proof is only as
 * strong as the host that served it, so a redirect elsewhere proves nothing.
 */
async function fetchVendorPage(url: URL, allowedHosts: readonly string[]) {
  let served = url;
  const response = await fetchExternalResponse(url, {
    timeoutMs: PAGE_TIMEOUT_MS,
    headers: { accept: "text/html,application/xhtml+xml" },
    fetcher: (hop, init) => {
      const hopUrl = new URL(hop instanceof Request ? hop.url : hop);
      if (!isVendorBrowserUrl(hopUrl, allowedHosts))
        throw offVendor(hopUrl, allowedHosts);
      served = hopUrl;
      return fetch(hop, init);
    },
  });
  if (response.status === 401 || response.status === 403)
    throw new CaptureRefusal(
      `${served.href} answered ${response.status}: a sign-in page is not product evidence`,
    );
  if (!response.ok)
    throw new CaptureRefusal(`${served.href} answered ${response.status}`);
  const mediaType = assertResponseContentType(response, [
    "text/html",
    "application/xhtml+xml",
  ]);
  const bytes = await readResponseWithLimit(response, MAX_EXTERNAL_HTML_BYTES);
  if (bytes.byteLength === 0)
    throw new CaptureRefusal(`${served.href} returned an empty page`);
  return { served, mediaType, bytes };
}

/**
 * Measure the page Product's images. An image that cannot be fetched or
 * read is left out rather than failing the capture: the identifiers on the
 * page are still evidence, and a commit can cite only measured images.
 */
async function measureImages(urls: readonly string[]) {
  const measured: HttpCaptureMetadata["images"] = [];
  for (const url of urls) {
    try {
      const response = await fetchExternalResponse(
        validateExternalHttpUrl(url),
        { timeoutMs: IMAGE_TIMEOUT_MS },
      );
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const contentType = assertResponseContentType(
        response,
        ALLOWED_IMAGE_TYPES,
      );
      const inspected = await inspectImageFile(
        await readResponseWithLimit(response, MAX_CAPTURE_IMAGE_BYTES),
        contentType,
      );
      if (!inspected.width || !inspected.height) continue;
      measured.push({
        url,
        naturalWidth: inspected.width,
        naturalHeight: inspected.height,
        highResolutionUrl: null,
        sha256: inspected.sha256,
      });
    } catch {
      // SILENT: see the function comment; an unmeasured image is omitted.
    }
  }
  return measured;
}

function captureResult(
  input: z.infer<typeof captureEnrichmentPageInput>,
  evidence: {
    id: string;
    checksum: string;
    byteSize: number | null;
    metadata: HttpCaptureMetadata;
  },
  replayed: boolean,
) {
  const [productNode] = evidence.metadata.structuredProducts.products;
  return captureEnrichmentPageOut.parse({
    runId: input.runId,
    productId: input.productId,
    evidenceId: evidence.id,
    replayed,
    sourceUrl: evidence.metadata.sourceURL,
    canonicalUrl: evidence.metadata.canonicalUrl,
    checksum: evidence.checksum,
    byteSize: evidence.byteSize,
    product: productNode,
    images: evidence.metadata.images.map(
      ({ url, naturalWidth, naturalHeight }) => ({
        url,
        naturalWidth,
        naturalHeight,
      }),
    ),
  });
}

/**
 * Fetch one vendor product page for a caller-owned run's pending target,
 * retain its bytes in R2 with their checksum, and record `http_capture`
 * evidence whose proof metadata the server derived itself. The row is written
 * only after the bytes are stored, and identical bytes for the same target
 * return the existing evidence.
 */
export async function captureEnrichmentPage(
  db: Database,
  actor: ActorContext,
  rawInput: z.input<typeof captureEnrichmentPageInput>,
) {
  const input = captureEnrichmentPageInput.parse(rawInput);
  const scope = await loadCallerRun(db, actor, input.runId);
  assertCallerRunActive(scope.public.status);
  const productId = await resolveOrThrow(db, "product", input.productId);
  const [target] = await getDb(db)
    .select({ id: runTarget.id })
    .from(runTarget)
    .where(
      and(
        eq(runTarget.runId, scope.public.runId),
        eq(runTarget.entityId, productId),
        inArray(runTarget.state, ["pending", "prepared"]),
      ),
    )
    .limit(1);
  if (!target)
    throw new CaptureRefusal(
      `${input.productId} is not a pending target of this run`,
    );
  const allowedHosts = scope.public.allowedHosts;
  const requested = validateExternalHttpUrl(input.url);
  if (!isVendorBrowserUrl(requested, allowedHosts))
    throw offVendor(requested, allowedHosts);

  const page = await fetchVendorPage(requested, allowedHosts);
  const structure = readProductPage(
    new TextDecoder().decode(page.bytes),
    page.served,
  );
  if (structure.signInForm)
    throw new CaptureRefusal(
      `${page.served.href} is a sign-in page, not product evidence`,
    );
  const { structuredProducts } = structure;
  if (
    structuredProducts.variantGroup ||
    structuredProducts.products.length !== 1
  )
    throw new CaptureRefusal(
      `${page.served.href} does not show exactly one Product (it has ${structuredProducts.products.length}${structuredProducts.variantGroup ? " in a ProductGroup" : ""}); capture the exact variant's own page`,
    );
  if (
    structure.canonicalUrl &&
    !isVendorBrowserUrl(new URL(structure.canonicalUrl), allowedHosts)
  )
    throw offVendor(new URL(structure.canonicalUrl), allowedHosts);

  const checksum = await sha256Hex(page.bytes);
  const [existing] = await getDb(db)
    .select({
      id: runEvidence.id,
      checksum: runEvidence.checksum,
      byteSize: runEvidence.byteSize,
      metadata: runEvidence.sourceMetadata,
    })
    .from(runEvidence)
    .where(
      and(
        eq(runEvidence.runId, scope.public.runId),
        eq(runEvidence.targetId, target.id),
        eq(runEvidence.kind, "http_capture"),
        eq(runEvidence.checksum, checksum),
      ),
    )
    .limit(1);
  if (existing)
    return captureResult(
      input,
      { ...existing, metadata: httpCaptureMetadata.parse(existing.metadata) },
      true,
    );

  const metadata = httpCaptureMetadata.parse({
    captureVersion: 1,
    requestedUrl: requested.href,
    sourceURL: page.served.href,
    canonicalUrl: structure.canonicalUrl,
    structuredProducts,
    requestedAmazonAsin: null,
    servedAmazonAsin: null,
    variantMarkers: [],
    images: await measureImages(structure.productImageUrls),
  });
  const evidenceId = crypto.randomUUID();
  const objectKey = `${env.R2_KEY_PREFIX}/import-runs/${input.runId}/${target.id}/${evidenceId}-page.html`;
  // Stored as plain text: the bucket is public, and vendor HTML must never
  // be served from it as an active document.
  await uploadToS3({
    key: objectKey,
    body: Buffer.from(page.bytes),
    contentType: "text/plain; charset=utf-8",
  });
  try {
    await getDb(db).insert(runEvidence).values({
      id: evidenceId,
      runId: scope.public.runId,
      targetId: target.id,
      kind: "http_capture",
      objectKey,
      checksum,
      mediaType: page.mediaType,
      byteSize: page.bytes.byteLength,
      sourceMetadata: metadata,
    });
  } catch (error) {
    // SILENT: cleanup of the bytes this call stored; the insert failure is
    // what the caller needs, and an orphan object only costs storage.
    await deleteS3Object(objectKey).catch(() => undefined);
    throw error;
  }
  // Activity for the stale-run sweep, which reviews an abandoned run.
  await getDb(db)
    .update(runTable)
    .set({ updatedAt: new Date() })
    .where(eq(runTable.id, scope.public.runId));
  return captureResult(
    input,
    { id: evidenceId, checksum, byteSize: page.bytes.byteLength, metadata },
    false,
  );
}
