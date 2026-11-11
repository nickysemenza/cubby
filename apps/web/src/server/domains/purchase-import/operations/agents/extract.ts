import { runEntityId } from "@cubby/schemas/identifiers";
import { normalizeImportAuditModelOutput } from "@cubby/schemas/purchase-import";
import { getErrorMessage } from "@cubby/shared";

import { PURCHASE_IMPORT_AUDIT_FEATURE } from "~/server/ai/policy/features";
import { type PurchaseAuditRenderedBatch } from "~/server/ai/policy/prompts/purchase-import";
import { runStructuredFeature } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";

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
        // The wire schema carries each fix as JSON text, so the domain check
        // runs here: an invalid fix escalates and is never cached.
        validate: (output) => {
          try {
            normalizeImportAuditModelOutput(output);
            return { ok: true };
          } catch (error) {
            return { ok: false, issues: [getErrorMessage(error)] };
          }
        },
      },
    ),
  );
