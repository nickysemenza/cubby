import { runEntityId } from "@cubby/schemas/identifiers";
import {
  browserCapture,
  type BrowserCapture,
  type ImportExtractionOutcome,
  importAuditModelOutput,
  normalizeImportAuditModelOutput,
  normalizeImportExtractionModelOutput,
} from "@cubby/schemas/purchase-import";
import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import { cents } from "@cubby/shared";
import {
  gatewayBaseURL,
  type GatewayResponseInfo,
} from "@cubby/shared/ai/gateway-request";
import {
  AUDIT_RECOVERY_MODEL,
  getChatModelConfig,
  providerFor,
} from "@cubby/shared/ai/models";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import { cachedCall } from "~/server/ai/adapters";
import { gatewayFetch } from "~/server/ai/gateway";
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
import { recordAiUsage } from "~/server/ai/usage";
import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
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

  const screenshot = args.screenshotImageId
    ? await getDb(args.db).query.image.findFirst({
        where: and(
          eq(image.shortcode, args.screenshotImageId),
          notDeleted(image),
        ),
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
const auditRecoveryResponse = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
  }),
});

export interface PurchaseAuditPorts {
  runStructured: typeof runStructuredFeature;
  gateway: typeof gatewayFetch;
  usage: typeof recordAiUsage;
}

const productionPurchaseAuditPorts: PurchaseAuditPorts = {
  runStructured: runStructuredFeature,
  gateway: gatewayFetch,
  usage: recordAiUsage,
};

async function recoverPurchaseAudit(
  args: {
    db: Database;
    runId: string;
    renderedBatch: PurchaseAuditRenderedBatch;
  },
  ports: PurchaseAuditPorts,
) {
  const started = Date.now();
  const request = PURCHASE_IMPORT_AUDIT_FEATURE.request(args.renderedBatch);
  const schema = z.toJSONSchema(importAuditModelOutput);
  // Anthropic accepts the same portable object as OpenAI once the generated
  // dialect marker is removed. No union or numeric bounds reach the provider.
  const { $schema: _dialect, ...outputSchema } = schema;
  const operation = "purchaseImport.audit.recovery";
  let transport: AiUsageTransport = "unknown";
  let gateway: GatewayResponseInfo | undefined;
  const fetchThroughGateway = ports.gateway(
    getChatModelConfig(AUDIT_RECOVERY_MODEL).gatewayProvider,
    {
      ...cachedCall({
        metadata: { feature: PURCHASE_IMPORT_AUDIT_FEATURE.feature, operation },
      }),
      onTransport: (selected) => {
        transport = selected;
      },
      onResponse: (info) => {
        gateway = info;
      },
    },
  );
  const usage = {
    provider: providerFor(AUDIT_RECOVERY_MODEL),
    model: AUDIT_RECOVERY_MODEL,
    feature: PURCHASE_IMPORT_AUDIT_FEATURE.feature,
    operation,
    runId: runEntityId.parse(args.runId),
  };
  const body = await requestAuditRecovery(
    fetchThroughGateway,
    request,
    outputSchema,
  ).catch(async (error: UnparsedError) => {
    // A failed attempt is still a call on its selected transport.
    await ports.usage(args.db, {
      ...usage,
      transport,
      status: "failed",
      durationMs: Date.now() - started,
      gatewayLogId: gateway?.gatewayLogId,
      gatewayCacheStatus: gateway?.gatewayCacheStatus,
    });
    throw error;
  });
  // Unpriced here: the telemetry consumer prices every token class from the
  // catalog, and the usage writer zeroes a gateway cache hit or plan answer.
  await ports.usage(args.db, {
    ...usage,
    transport,
    inputTokens: body.usage.input_tokens,
    outputTokens: body.usage.output_tokens,
    cacheReadTokens: body.usage.cache_read_input_tokens ?? null,
    cacheWriteTokens: body.usage.cache_creation_input_tokens ?? null,
    durationMs: Date.now() - started,
    gatewayLogId: gateway?.gatewayLogId,
    gatewayCacheStatus: gateway?.gatewayCacheStatus,
  });
  const text = body.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  return normalizeImportAuditModelOutput(
    importAuditModelOutput.parse(JSON.parse(text)),
  );
}

async function requestAuditRecovery(
  fetchThroughGateway: typeof fetch,
  request: ReturnType<typeof PURCHASE_IMPORT_AUDIT_FEATURE.request>,
  outputSchema: Omit<z.core.JSONSchema.BaseSchema, "$schema">,
) {
  const response = await fetchThroughGateway(
    `${gatewayBaseURL("anthropic")}/v1/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: AUDIT_RECOVERY_MODEL,
        max_tokens: PURCHASE_IMPORT_AUDIT_FEATURE.maxTokens,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          format: { type: "json_schema", schema: outputSchema },
        },
        system: request.systemPrompts.join("\n\n"),
        messages: request.messages,
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `Audit recovery failed (${response.status}): ${await response.text()}`,
    );
  return auditRecoveryResponse.parse(await response.json());
}

export const auditPurchaseImportBatch = async (
  args: {
    db: Database;
    runId: string;
    renderedBatch: PurchaseAuditRenderedBatch;
  },
  ports: PurchaseAuditPorts = productionPurchaseAuditPorts,
) => {
  try {
    return normalizeImportAuditModelOutput(
      await ports.runStructured(
        PURCHASE_IMPORT_AUDIT_FEATURE,
        PURCHASE_IMPORT_AUDIT_FEATURE.request(args.renderedBatch),
        {
          db: args.db,
          operation: "purchaseImport.audit",
          runId: runEntityId.parse(args.runId),
        },
      ),
    );
  } catch (primaryError) {
    try {
      return await recoverPurchaseAudit(args, ports);
    } catch (recoveryError) {
      throw new AggregateError(
        [primaryError, recoveryError],
        "Purchase import audit failed on both models",
        { cause: recoveryError },
      );
    }
  }
};

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
