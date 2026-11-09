import { runEntityId } from "@cubby/schemas/identifiers";
import {
  browserCapture,
  type BrowserCapture,
  type ImportExtractionOutcome,
  normalizeImportAuditModelOutput,
  normalizeImportExtractionModelOutput,
} from "@cubby/schemas/purchase-import";
import { cents } from "@cubby/shared";
import { and, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  PURCHASE_IMPORT_AUDIT_FEATURE,
  PURCHASE_IMPORT_EXTRACTION_FEATURE,
  PURCHASE_IMPORT_RECEIPT_FEATURE,
  PURCHASE_IMPORT_REPAIR_FEATURE,
} from "~/server/ai/policy/features";
import {
  SUM_MISMATCH_ISSUE,
  type PurchaseAuditRenderedBatch,
} from "~/server/ai/policy/prompts/purchase-import";
import { runStructuredFeature } from "~/server/ai/run-feature";
import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { image } from "~/server/db/schema";

const validateExtraction = (output: ImportExtractionOutcome) => {
  const candidate = output.candidate;
  if (!candidate) return { ok: true } as const;
  if (candidate.currency !== "USD" || candidate.printedGrandTotal === null)
    return { ok: true } as const;
  const lineTotal = candidate.lines.reduce(
    (sum, line) => sum + cents(line.amount),
    0,
  );
  if (lineTotal === cents(candidate.printedGrandTotal))
    return { ok: true } as const;
  if (output.status === "needs_review" && output.reason === "sum_mismatch")
    return { ok: true } as const;
  return {
    ok: false,
    issues: [SUM_MISMATCH_ISSUE],
  };
};

/** Loaded lazily by the purchase-import service to keep its bootstrap small. */
export const extractPurchaseCapture = async (
  args: {
    db: Database;
    runId: string;
    capture: BrowserCapture;
    screenshotImageId?: string | null;
  },
  ports = { runStructured: runStructuredFeature },
) => {
  return extractPurchaseText(
    {
      ...args,
      request: PURCHASE_IMPORT_EXTRACTION_FEATURE.request(
        browserCapture.parse(args.capture),
      ),
    },
    ports,
  );
};

/**
 * Keep a line's product link and image only when the saved email literally
 * contains them: the model may copy a URL, never compose one. A product link
 * must also be on the Vendor's own site, so a mail-platform click-tracking
 * redirect never becomes the Product's identity URL.
 */
export function retainLiteralLineLinks<
  T extends { productUrl?: string; imageUrl?: string },
>(
  line: T,
  content: { bodyHtml: string | null; bodyText: string | null },
  productHosts: readonly string[],
): T {
  const literal = literalEmailUrls(content);
  const kept = { ...line };
  if (
    kept.productUrl &&
    !(literal.has(kept.productUrl) && onHost(kept.productUrl, productHosts))
  )
    delete kept.productUrl;
  if (kept.imageUrl && !literal.has(kept.imageUrl)) delete kept.imageUrl;
  return kept;
}

/**
 * Every whole URL the email shows: `href`/`src` attribute values (HTML-escaped
 * `&` decoded) and bare URLs in its text. A model URL must equal one of these,
 * so a prefix of a longer link never passes.
 */
function literalEmailUrls(content: {
  bodyHtml: string | null;
  bodyText: string | null;
}) {
  const urls = new Set<string>();
  for (const match of (content.bodyHtml ?? "").matchAll(
    /\b(?:href|src)\s*=\s*(["'])(.*?)\1/giu,
  ))
    if (match[2]) urls.add(match[2].replaceAll("&amp;", "&").trim());
  for (const match of (content.bodyText ?? "").matchAll(
    /https?:\/\/[^\s<>"')\]]+/giu,
  ))
    urls.add(match[0]);
  return urls;
}

function onHost(url: string, hosts: readonly string[]) {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    // SILENT: an unparseable link is simply not a product URL.
    return false;
  }
  return hosts.some((host) => {
    const domain = host.toLowerCase().replace(/^www\./u, "");
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
}

const extractPurchaseText = async (
  args: {
    db: Database;
    runId: string;
    request: ReturnType<typeof PURCHASE_IMPORT_EXTRACTION_FEATURE.request>;
    screenshotImageId?: string | null;
  },
  ports = { runStructured: runStructuredFeature },
) => {
  const request = args.request;
  const first = normalizeImportExtractionModelOutput(
    await ports.runStructured(PURCHASE_IMPORT_EXTRACTION_FEATURE, request, {
      db: args.db,
      operation: "purchaseImport.extract",
      runId: runEntityId.parse(args.runId),
    }),
  );
  const validation = validateExtraction(first);
  if (validation.ok) return first;

  const screenshotImageId = args.screenshotImageId;
  const screenshot = screenshotImageId
    ? await getDb(args.db).query.image.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              and(eq(image.shortcode, screenshotImageId), notDeleted(image)),
            ),
        },
        columns: { key: true },
      })
    : null;
  const repaired = normalizeImportExtractionModelOutput(
    await ports.runStructured(
      PURCHASE_IMPORT_REPAIR_FEATURE,
      PURCHASE_IMPORT_REPAIR_FEATURE.request(
        request,
        validation.issues,
        first,
        screenshot ? getR2PublicUrl(screenshot.key) : null,
      ),
      {
        db: args.db,
        operation: "purchaseImport.repair",
        runId: runEntityId.parse(args.runId),
      },
    ),
  );
  return settleRepairedExtraction(repaired);
};

/**
 * What production keeps from the one repair answer: a repair that still does
 * not balance is retained for review as `sum_mismatch`, never used as ready.
 */
export function settleRepairedExtraction(
  repaired: ImportExtractionOutcome,
): ImportExtractionOutcome {
  const validation = validateExtraction(repaired);
  if (validation.ok || !repaired.candidate) return repaired;
  return {
    status: "needs_review",
    candidate: repaired.candidate,
    reason: "sum_mismatch",
    detail: validation.issues.join(" ").slice(0, 2_000),
  };
}

/** Loaded lazily by the purchase-import service to keep its bootstrap small. */
export const auditPurchaseImportBatch = async (args: {
  db: Database;
  runId: string;
  renderedBatch: PurchaseAuditRenderedBatch;
}) =>
  normalizeImportAuditModelOutput(
    await runStructuredFeature(
      PURCHASE_IMPORT_AUDIT_FEATURE,
      PURCHASE_IMPORT_AUDIT_FEATURE.request(args.renderedBatch),
      {
        db: args.db,
        operation: "purchaseImport.audit",
        runId: runEntityId.parse(args.runId),
      },
    ),
  );

export const extractPurchaseEvidence = async (args: {
  db: Database;
  runId: string;
  evidenceUrl: string;
  mediaType: string;
}) =>
  normalizeImportExtractionModelOutput(
    await runStructuredFeature(
      PURCHASE_IMPORT_RECEIPT_FEATURE,
      PURCHASE_IMPORT_RECEIPT_FEATURE.request(args),
      {
        db: args.db,
        operation: "purchaseImport.extractReceipt",
        runId: runEntityId.parse(args.runId),
        validate: (output) =>
          validateExtraction(normalizeImportExtractionModelOutput(output)),
      },
    ),
  );
