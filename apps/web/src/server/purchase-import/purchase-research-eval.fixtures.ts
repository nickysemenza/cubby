import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { ActorContext } from "@cubby/schemas/context";
import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared/constants";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  entityAttachment,
  entityExternalId,
  expense,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  ledgerParty,
  mailboxMessage,
  orderMail,
  product,
  runEvidence,
  vendor,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { productResearchFixture } from "./product-research.fixtures";

/**
 * Researcher boundary: real mounted tools, production retained observations and
 * support assessment. Only public-source transport is fixed. Expected answers
 * never enter the Worker, search descriptions, run instructions, or page HTML.
 * Positive cases require current proof, not merely correct populated values.
 * Wrong variants, unsupported mutations/proofs, skipped positives, timeout,
 * intervention, or inference outside the shared allowance fail acceptance.
 * Every fixture is admitted before inference; owned retained mail UUIDs and typed
 * original-line Product edges are required. An unsettled/refused case stops the
 * pilot before another peer allowance is configured. Missing proof is distinct
 * from a supported canonical value being changed to an unsupported value.
 * Money, ownership, replay and broker recovery belong to deterministic suites.
 */
export const researchEvalCases = [
  {
    name: "ordinary-product",
    orderedTitle: "Example Works desk fan",
    initialModel: "",
    expectedModel: "F-10",
    expectedSku: null,
    ambiguous: false,
    expectedMissingFields: ["categoryId", "externalIds", "images"],
    pages: [
      {
        url: "https://maker.example.test/desk-fan",
        title: "Example Works desk fan",
        description: "Manufacturer product specification page.",
        html: `<html><head><title>Example Works desk fan</title><script type="application/ld+json">{"@type":"Product","name":"Example Works desk fan","brand":{"name":"Example Works"},"model":"F-10"}</script></head><body><h1>Example Works desk fan</h1><p>Manufacturer: Example Works. Model: F-10. This desk fan has one model and no size or color variants.</p></body></html>`,
      },
    ],
  },
  {
    name: "selected-variant-no-jsonld",
    orderedTitle: "Example Works portable fan, small, blue",
    initialModel: "",
    expectedModel: "P-20-SB",
    expectedSku: "FAN-SM-BL",
    ambiguous: false,
    expectedMissingFields: ["categoryId", "images"],
    pages: [
      {
        url: "https://maker.example.test/portable-fan",
        title: "Example Works portable fan",
        description: "Portable fan with size and color choices.",
        html: `<html><head><title>Portable fan</title></head><body><h1>Example Works portable fan</h1><p>Selected variant: large, red. Model P-20-LR. Retailer SKU FAN-LG-RD.</p><a href="https://maker.example.test/portable-fan?size=small&amp;color=blue">Small, blue</a><a href="https://maker.example.test/portable-fan?size=large&amp;color=red">Large, red</a><p>Specifications and SKU change with the selected size and color.</p></body></html>`,
      },
      {
        url: "https://maker.example.test/portable-fan?size=small&color=blue",
        title: "Example Works portable fan — small, blue",
        description: "Small blue variant product page.",
        html: `<html><head><title>Portable fan, small blue</title></head><body><h1>Example Works portable fan</h1><select aria-label="Size"><option selected>Small</option><option>Large</option></select><select aria-label="Color"><option selected>Blue</option><option>Red</option></select><p>Selected variant: small, blue. Manufacturer: Example Works. Model P-20-SB. Retailer SKU FAN-SM-BL.</p><p>The large red fan has model P-20-LR and SKU FAN-LG-RD; those identifiers do not apply to this selected small blue fan.</p></body></html>`,
      },
    ],
  },
  {
    name: "existing-correct-facts",
    orderedTitle: "Example Works task light",
    initialModel: "L-30",
    expectedModel: "L-30",
    expectedSku: null,
    ambiguous: false,
    expectedMissingFields: ["categoryId", "externalIds", "images"],
    pages: [
      {
        url: "https://maker.example.test/task-light",
        title: "Example Works task light",
        description: "Task light manufacturer specifications.",
        html: `<html><head><title>Task light</title></head><body><h1>Example Works task light</h1><p>Manufacturer: Example Works. Model L-30. There are no alternate sizes, colors, or model variants for this task light.</p></body></html>`,
      },
    ],
  },
  {
    name: "genuine-ambiguity",
    orderedTitle: "Example Works modular adapter",
    initialModel: "",
    expectedModel: "",
    expectedSku: null,
    ambiguous: true,
    expectedMissingFields: [
      "manufacturer",
      "model",
      "categoryId",
      "externalIds",
      "images",
    ],
    pages: [
      {
        url: "https://maker.example.test/modular-adapter",
        title: "Example Works modular adapter",
        description:
          "Adapter family specifications and identification guidance.",
        html: `<html><head><title>Modular adapter</title></head><body><h1>Example Works modular adapter</h1><p>The same printed name and appearance are used for two incompatible models, A-40 and A-41. Their retailer SKUs are ADAPT-40 and ADAPT-41. Purchase receipts print only Example Works modular adapter and do not distinguish the models. The underside serial label or a connector measurement is required to identify which adapter was ordered. No such label or measurement is available on this page.</p></body></html>`,
      },
    ],
  },
] as const;

export type ResearchEvalCase = (typeof researchEvalCases)[number];

/** Materialize original purchased context before an inference peer is configured. */
export async function prepareResearchEvalFixture(
  db: Database,
  actor: ActorContext,
  scenario: ResearchEvalCase,
) {
  const sellerName = "Example Works synthetic evaluation seller";
  const [existingSeller] = await getDb(db)
    .select()
    .from(vendor)
    .where(eq(vendor.name, sellerName));
  const seller =
    existingSeller ??
    (await insertWithShortcode(db, "vendor", {
      name: sellerName,
      website: "https://maker.example.test",
    }));
  const [existingParty] = await getDb(db)
    .select()
    .from(ledgerParty)
    .where(
      and(eq(ledgerParty.userId, actor.userId), eq(ledgerParty.kind, "member")),
    );
  const fixture = await productResearchFixture(db, actor, {
    party: existingParty,
    vendor: seller,
    orderId: `SYNTHETIC-ORDER-${randomUUID()}`,
  });
  const name = `${scenario.orderedTitle} — synthetic ${scenario.name}`;
  await getDb(db)
    .update(product)
    .set({
      name,
      model: scenario.initialModel,
      manufacturer:
        scenario.name === "existing-correct-facts" || scenario.ambiguous
          ? "Example Works"
          : UNSPECIFIED_MANUFACTURER,
    })
    .where(eq(product.id, fixture.item.entityId));
  const sourceURL = scenario.pages[0].url;
  await getDb(db)
    .update(expense)
    .set({ name: scenario.orderedTitle, url: sourceURL })
    .where(eq(expense.productId, fixture.item.entityId));
  if (!fixture.association)
    throw new Error("Synthetic source association unavailable");
  const text = `Order ${fixture.order.orderId}. Ordered September 1, 2026. Seller Example Works. Item: ${scenario.orderedTitle}. Quantity 1, amount USD 24. Product page ${sourceURL}. Grand total USD 24.`;
  const checksum = createHash("sha256").update(text).digest("hex");
  const [mail] = await getDb(db)
    .insert(orderMail)
    .values({
      ledgerPartyId: fixture.party.id,
      mailboxId: "synthetic-eval-mailbox",
      messageId: randomUUID(),
      sender: "orders@maker.example.test",
      subject: "Synthetic purchased Product",
      receivedAt: new Date("2026-09-01T12:00:00Z"),
      rawChecksum: checksum,
      content: { snippet: null, bodyHtml: null, bodyText: text },
    })
    .returning();
  if (!mail) throw new Error("Synthetic retained mail missing");
  await getDb(db).insert(mailboxMessage).values({
    ledgerPartyId: fixture.party.id,
    mailboxId: mail.mailboxId,
    messageId: mail.messageId,
    checksum,
    classification: "related",
    classificationVersion: "synthetic-eval-v1",
    status: "pending",
    orderMailId: mail.id,
  });
  await getDb(db)
    .update(importSourceClaim)
    .set({ externalKey: mail.id, checksum })
    .where(eq(importSourceClaim.id, fixture.association.sourceClaimId));
  await getDb(db).insert(importSourceProduct).values({
    sourceOrderId: fixture.association.id,
    productId: fixture.item.entityId,
    lineIndex: 0,
  });
  await getDb(db)
    .update(importSourceOrder)
    .set({
      checksum,
      originalOrder: acceptedSourceOrder.parse({
        checksum,
        extraction: {
          status: "ready",
          candidate: {
            orderId: fixture.order.orderId,
            orderedAt: "2026-09-01T12:00:00Z",
            merchant: "Example Works",
            currency: "USD",
            printedGrandTotal: 24,
            lines: [
              {
                title: scenario.orderedTitle,
                amount: 24,
                lineKind: "principal",
                productUrl: sourceURL,
              },
            ],
            payments: [],
            allShipmentsDelivered: null,
          },
        },
      }),
    })
    .where(eq(importSourceOrder.id, fixture.association.id));
  return { ...fixture, mail };
}

export function canonicalFailures(
  scenario: ResearchEvalCase,
  current: typeof product.$inferSelect | undefined,
  identifiers: (typeof entityExternalId.$inferSelect)[],
  images: (typeof entityAttachment.$inferSelect)[],
  baseline: typeof product.$inferSelect,
) {
  const failures: string[] = [];
  if (
    !current ||
    (current.manufacturer !== baseline.manufacturer &&
      current.manufacturer !== "Example Works") ||
    (current.model !== baseline.model &&
      current.model !== scenario.expectedModel) ||
    current.categoryId !== null ||
    images.length
  )
    failures.push("Unsupported canonical identity/category/image mutation");
  if (
    identifiers.some(
      (id) =>
        id.kind !== "retailer_sku" || id.externalId !== scenario.expectedSku,
    )
  )
    failures.push("Unsupported or wrong-variant identifier");
  return failures;
}

export async function waitForResearchEvalSettlement(input: {
  begin: number;
  timeoutMs: number;
  readState: () => Promise<string | null>;
  readBudgets: () => Promise<{ refusedRequests: number }[]>;
}) {
  while (Date.now() - input.begin < input.timeoutMs) {
    if (
      (await input.readBudgets()).some((budget) => budget.refusedRequests > 0)
    )
      return "budget_refused";
    const status = await input.readState();
    if (status && status !== "running") return status;
    await sleep(250);
  }
  return "timeout";
}

export async function retainedSourceFailures(
  evidence: (typeof runEvidence.$inferSelect)[],
  scenario: ResearchEvalCase,
  storageURL: string | undefined,
  mail: typeof orderMail.$inferSelect,
) {
  if (!storageURL) throw new Error("Synthetic object storage was not started");
  const expectedMailChecksum = createHash("sha256")
    .update(
      JSON.stringify({
        sender: mail.sender,
        subject: mail.subject,
        receivedAt: mail.receivedAt?.toISOString() ?? null,
        content: mail.content,
        attachments: [],
      }),
    )
    .digest("hex");
  const mailMetadata = z.object({
    orderMailId: z.string(),
    checksum: z.string(),
    contextOnly: z.literal(true),
  });
  const pageMetadata = z.object({
    sourceURL: z.string(),
    servedURL: z.string(),
  });
  const failures: string[] = [];
  for (const retained of evidence) {
    const metadata =
      retained.kind === "mail_message"
        ? mailMetadata.safeParse(retained.sourceMetadata)
        : null;
    const page =
      retained.kind === "web_page"
        ? pageMetadata.safeParse(retained.sourceMetadata)
        : null;
    const recognizedMail =
      metadata?.success &&
      metadata.data.orderMailId === mail.id &&
      metadata.data.checksum === mail.rawChecksum &&
      retained.checksum === expectedMailChecksum;
    const recognizedPage =
      page?.success &&
      scenario.pages.some(
        (source) =>
          source.url === page.data.sourceURL &&
          source.url === page.data.servedURL &&
          createHash("sha256").update(source.html).digest("hex") ===
            retained.checksum,
      );
    if (!recognizedMail && !recognizedPage)
      failures.push("Evidence did not retain exact fixed source bytes");
    const stored = await fetch(
      `${storageURL}/e2e-bucket/${retained.objectKey}`,
    );
    if (
      !stored.ok ||
      createHash("sha256")
        .update(new Uint8Array(await stored.arrayBuffer()))
        .digest("hex") !== retained.checksum
    )
      failures.push("Retained source bytes were unavailable or changed");
  }
  return failures;
}
