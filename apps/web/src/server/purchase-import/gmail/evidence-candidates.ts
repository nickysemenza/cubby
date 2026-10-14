import {
  emailCandidateSource,
  preparedEmailCandidates,
  type EmailCandidateSource,
  type EmailEvidenceCandidate,
} from "@cubby/schemas/email-candidates";
import { wholeCentAmount } from "@cubby/schemas/money";
import {
  importExtractionOutcome,
  type ExtractedPurchaseLine,
} from "@cubby/schemas/purchase-import";
import { cents, dollars } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import { sourceFinancialFacts } from "../writer-policy";

const amount = z.union([
  wholeCentAmount,
  z
    .string()
    .regex(/^-?\d+(?:\.\d{1,2})?$/)
    .transform(Number)
    .pipe(wholeCentAmount),
]);
const offer = z.looseObject({
  price: amount,
  priceCurrency: z.string().optional(),
});
const item = z.looseObject({
  orderQuantity: z.number().positive().finite(),
  orderedItem: z.looseObject({
    name: z.string().trim().min(1),
    sku: z.string().optional(),
    url: z.url().optional(),
    offers: offer,
  }),
});
const adjustment = z.looseObject({
  name: z.string().min(1),
  price: amount,
  priceCurrency: z.string().optional(),
});
const structuredOrder = z.looseObject({
  "@type": z.literal("Order"),
  orderNumber: z.string().trim().min(1),
  orderDate: z.string(),
  seller: z.looseObject({ name: z.string().trim().min(1) }),
  priceCurrency: z.literal("USD"),
  price: amount,
  orderedItem: z.array(item).min(1).max(50),
  priceSpecification: z.array(adjustment).max(30).default([]),
});

function orderLines(
  order: z.infer<typeof structuredOrder>,
): ExtractedPurchaseLine[] {
  const lines: ExtractedPurchaseLine[] = order.orderedItem.map((entry) => {
    const product = entry.orderedItem;
    if (
      product.offers.priceCurrency &&
      product.offers.priceCurrency !== order.priceCurrency
    )
      throw new Error("Line currency does not match order currency");
    if (product.offers.price < 0)
      throw new Error("Purchase principal unit price is negative");
    const line: ExtractedPurchaseLine = {
      title: product.name,
      quantity: entry.orderQuantity,
      amount: wholeCentAmount.parse(product.offers.price * entry.orderQuantity),
      lineKind: "principal",
    };
    if (product.sku) line.sku = product.sku;
    if (product.url) line.productUrl = product.url;
    return line;
  });
  for (const entry of order.priceSpecification) {
    if (entry.priceCurrency && entry.priceCurrency !== order.priceCurrency)
      throw new Error("Adjustment currency does not match order currency");
    lines.push({
      title: entry.name,
      amount: entry.price,
      lineKind: "unclassified",
    });
  }
  return lines;
}
const structuredJson = z.json();
type StructuredEvidence = z.infer<typeof structuredJson>;
function readyOrder(value: StructuredEvidence) {
  const order = structuredOrder.parse(value);
  const extraction = importExtractionOutcome.parse({
    status: "ready",
    candidate: {
      orderId: order.orderNumber,
      merchant: order.seller.name,
      orderedAt: order.orderDate,
      currency: order.priceCurrency,
      printedGrandTotal: order.price,
      lines: orderLines(order),
      payments: [],
      allShipmentsDelivered: null,
    },
  });
  if (extraction.status !== "ready") throw new Error("Candidate is not ready");
  const facts = sourceFinancialFacts(extraction.candidate);
  const total = extraction.candidate.lines.reduce(
    (sum, line) => sum + cents(wholeCentAmount.parse(line.amount)),
    0,
  );
  if (
    !extraction.candidate.lines.every((line) =>
      Number.isSafeInteger(cents(line.amount)),
    ) ||
    !Number.isSafeInteger(total) ||
    total !== facts.total ||
    order.price < 0
  )
    throw new Error("Whole order lines do not conserve the printed total");
  // Reuse the cent-domain projection; reject unsafe values rather than rounding evidence.
  if (dollars(total) !== order.price)
    throw new Error("Printed total is outside exact cent accounting");
  return extraction;
}

function orderNodes(
  value: StructuredEvidence,
  depth = 0,
): StructuredEvidence[] {
  if (depth > 4)
    throw new Error("Structured evidence nesting exceeds its bound");
  const array = z.array(structuredJson).safeParse(value);
  if (array.success) {
    if (array.data.length > 32)
      throw new Error("Structured evidence roster exceeds its bound");
    return array.data.flatMap((entry) => orderNodes(entry, depth + 1));
  }
  const object = z.record(z.string(), structuredJson).safeParse(value);
  if (!object.success) return [];
  const record = object.data;
  if (record["@type"] === "Order") return [record];
  if (record["@graph"]) return orderNodes(record["@graph"], depth + 1);
  return [];
}

/** Read only complete structured Orders; a model never fills missing evidence. */
export async function prepareEmailEvidenceCandidates(
  input: EmailCandidateSource,
) {
  // Validate identity and shape before applying the bounded extraction contract.
  // Oversized originals remain eligible retained content with an explicit abstention.
  const envelope = emailCandidateSource
    .extend({ content: z.string() })
    .parse(input);
  const contentTooLarge =
    envelope.content.length > 200_000 ||
    new TextEncoder().encode(envelope.content).byteLength > 200_000;
  const source = contentTooLarge
    ? envelope
    : emailCandidateSource.parse(envelope);
  const contentChecksum = await sha256Hex(source.content);
  const base = {
    sourceKey: source.sourceKey,
    checksum: source.checksum,
    contentChecksum,
  };
  const candidates: EmailEvidenceCandidate[] = [];
  if (contentTooLarge)
    return preparedEmailCandidates.parse({
      ...base,
      candidates,
      reason: "source_too_large",
    });
  const scripts = source.content.matchAll(
    /<script\b[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json')[^>]*>([\s\S]*?)(<\/script\s*>)/giu,
  );
  let scriptsSeen = 0;
  try {
    for (const script of scripts) {
      if (++scriptsSeen > 8)
        throw new Error("Structured evidence script count exceeds its bound");
      const json = script[1];
      if (!json) continue;
      const start =
        script.index +
        script[0].length -
        (script[2]?.length ?? 0) -
        json.length;
      const span = { start, end: start + json.length };
      for (const node of orderNodes(structuredJson.parse(JSON.parse(json)))) {
        const extraction = readyOrder(node);
        if (candidates.length >= 8)
          throw new Error("Order candidate count exceeds its bound");
        if (
          candidates.some(
            (entry) =>
              entry.extraction.candidate?.orderId ===
              extraction.candidate.orderId,
          )
        )
          throw new Error(
            "Order identity has ambiguous duplicate totals or details",
          );
        const id = await sha256Hex(
          JSON.stringify({ ...base, span, extraction }),
        );
        candidates.push({ ...base, id, span, extraction });
      }
    }
  } catch {
    // SILENT: malformed or incomplete structured evidence is an explicit abstention, never a guessed order.
    return preparedEmailCandidates.parse({
      ...base,
      candidates: [],
      reason: "incomplete_or_ambiguous_order",
    });
  }
  return preparedEmailCandidates.parse({
    ...base,
    candidates,
    reason: candidates.length ? null : "no_complete_order",
  });
}
