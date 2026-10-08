import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";

import * as schema from "~/server/db/schema";
import { completedCapture } from "~/server/purchase-import/browser.fixtures";
import { startMailResearch } from "~/server/purchase-import/research-run";
import { authorizePurchaseAgent } from "~/server/purchase-import/purchase-agent-workerd.fixtures";
import {
  assetKey,
  assetURL,
  mailSteps,
  orderedTitle,
  page as capturedPage,
  pageURL,
  png,
  productSteps,
  sourceText,
  step,
  support,
} from "~/server/purchase-import/purchase-research-journey.fixtures";
import { getDb } from "~/server/repo/database-helpers";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { from } from "../../tooling/purchase-agent-script";
import {
  ensureMemberParty,
  fixtureUserId,
  getFixtureDb,
} from "./fixtures-core";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Automatic retained-mail admission uses the real queue and durable researcher.
// Product navigation, images and provenance use the real UI; model judgment and
// the external Mac capture are scripted, while Gmail discovery is covered separately.
// This journey owns visible proof/image and later lifecycle convergence;
// real-model research quality has separate fixed-source acceptance.
test.use({
  workerdProfile: "purchase-agent",
  objectStoragePublicUrl: new URL(assetURL).origin,
});

test.afterEach(async ({ e2eRuntime }, testInfo) => {
  const agent = e2eRuntime.purchaseAgent;
  if (!agent) return;
  const db = getDb(getFixtureDb());
  const [runs, targets, operations, emitted, violations] = await Promise.all([
    db.select().from(schema.run),
    db.select().from(schema.runTarget),
    db.select().from(schema.runOperation),
    agent.emitted(),
    agent.violations(),
  ]);
  await testInfo.attach("synthetic-research-outcomes", {
    body: JSON.stringify({
      synthetic: true,
      runs,
      targets,
      operations,
      emitted,
      violations,
    }),
    contentType: "application/json",
  });
});

test("imports an original, automatically verifies the exact Product with visible proof and an image, then links shipment evidence without more spend or stock", async ({
  page,
  e2eRuntime,
}) => {
  const agent = e2eRuntime.purchaseAgent;
  if (!agent) throw new Error("The research harness is unavailable.");
  const db = getFixtureDb();
  const database = getDb(db);
  const userId = await fixtureUserId(page);
  const member = await ensureMemberParty(page, "Synthetic research member");
  const seller = await insertWithShortcode(db, "vendor", {
    name: "Example Works",
    website: "https://maker.example.test",
    browserDomains: ["maker.example.test"],
  });
  const account = await insertWithShortcode(db, "vendorAccount", {
    label: "Synthetic research transport",
    vendorId: seller.id,
    ledgerPartyId: member.id,
    browserSyncEnabled: true,
  });
  const original = async (subject: string, bodyText: string) => {
    const checksum = await sha256Hex(bodyText);
    const [mail] = await database
      .insert(schema.orderMail)
      .values({
        ledgerPartyId: member.id,
        vendorId: seller.id,
        mailboxId: "synthetic-visible-proof-mailbox",
        messageId: crypto.randomUUID(),
        threadId: `synthetic-thread-${crypto.randomUUID()}`,
        sender: "orders@maker.example.test",
        subject,
        receivedAt: new Date("2026-09-14T12:00:00Z"),
        rawChecksum: checksum,
        content: { snippet: null, bodyHtml: null, bodyText },
      })
      .returning();
    if (!mail) throw new Error("Synthetic retained original is unavailable.");
    await database.insert(schema.mailboxMessage).values({
      ledgerPartyId: member.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      checksum,
      classification: "related",
      classificationVersion: "synthetic-positive-source-v1",
      status: "pending",
      orderMailId: mail.id,
    });
    return mail;
  };
  const confirmation = await original("Synthetic fan confirmation", sourceText);
  const uploaded = await fetch(
    `${e2eRuntime.objectStorageUrl}/e2e-bucket/${encodeURIComponent(assetKey)}`,
    { method: "PUT", headers: { "Content-Type": "image/png" }, body: png },
  );
  expect(uploaded.ok).toBe(true);
  const catalog = await createImageFixture(db, "synthetic-research-fan", {
    key: assetKey,
    source: "catalog",
    sourceAssetUrl: assetURL,
    sha256: null,
    contentType: "image/png",
    size: png.byteLength,
  });
  await authorizePurchaseAgent(db, userId);
  await page.route(`${new URL(assetURL).origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const response = await page.request.get(
      `${e2eRuntime.objectStorageUrl}${path}`,
    );
    await route.fulfill({ response });
  });
  const productAssessment = {
    match: "F17SB",
    output: {
      identityVerified: true,
      acceptedFacts: [0, 1, 2],
      acceptedIdentifiers: [],
      acceptedIdentifierClaims: [0],
      acceptedImages: [0],
      acceptedOrders: [],
      acceptedEmailLinks: [],
      rejected: [],
    },
  };
  await agent.configure({
    steps: mailSteps,
    purposeSteps: { product_enrichment: productSteps },
    assessments: [
      {
        match: "SYNTHETIC-410 has one item",
        output: {
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedOrders: [0],
          acceptedEmailLinks: [],
          rejected: [],
        },
      },
      productAssessment,
    ],
  });
  await agent.connectBrowser({
    vendorAccountId: account.id,
    ledgerPartyId: member.id,
    userId,
    outcomes: { [pageURL]: await completedCapture(pageURL, capturedPage) },
  });
  const admitOriginal = (mail: typeof confirmation) =>
    startMailResearch(
      db,
      {
        ledgerPartyId: member.id,
        userId,
        mailboxId: mail.mailboxId,
        messageIds: [mail.id],
      },
      {
        send: async (event) => {
          await agent.dispatch(event);
        },
      },
    );
  await admitOriginal(confirmation);
  await gotoAuthenticatedPage(
    page,
    `/vendors/${seller.shortcode}`,
    page.getByText(confirmation.subject, { exact: true }),
  );
  await expect
    .poll(
      async () => {
        const [item] = await database
          .select({ id: schema.product.id, model: schema.product.model })
          .from(schema.product)
          .where(eq(schema.product.name, orderedTitle));
        return item?.model;
      },
      { timeout: 40_000 },
    )
    .toBe("F17SB");
  const [bought] = await database
    .select()
    .from(schema.purchase)
    .where(eq(schema.purchase.vendorId, seller.id));
  const [item] = await database
    .select()
    .from(schema.product)
    .where(eq(schema.product.name, orderedTitle));
  if (!bought || !item)
    throw new Error("Supported import records are missing.");
  await expect
    .poll(
      async () => {
        const [child] = await database
          .select({ status: schema.run.status })
          .from(schema.run)
          .innerJoin(
            schema.runTarget,
            eq(schema.runTarget.runId, schema.run.id),
          )
          .where(
            and(
              eq(schema.runTarget.entityId, item.id),
              eq(schema.run.purpose, "product_enrichment"),
            ),
          );
        return child?.status;
      },
      { timeout: 20_000 },
    )
    .toBe("completed");
  const financialBefore = await database
    .select()
    .from(schema.expense)
    .where(eq(schema.expense.purchaseId, bought.id));
  expect(financialBefore).toMatchObject([{ cost: 24, productId: item.id }]);
  const proof = await database
    .select()
    .from(schema.runFactEvidence)
    .where(
      and(
        eq(schema.runFactEvidence.entityKind, "product"),
        eq(schema.runFactEvidence.entityId, item.id),
      ),
    );
  expect(proof.map((row) => row.fieldPath)).toEqual(
    expect.arrayContaining(["manufacturer", "model", "categoryId"]),
  );
  await gotoAuthenticatedPage(page, `/purchases/${bought.shortcode}`);
  await page
    .getByRole("link", { name: orderedTitle, exact: true })
    .and(page.locator(`[href='/products/${item.shortcode}']`))
    .click();
  await expect(page).toHaveURL(new RegExp(`/products/${item.shortcode}$`, "u"));
  await expect(page.getByText("F17SB", { exact: true })).toBeVisible();
  const image = page
    .locator("#images")
    .getByRole("img", { name: catalog.filename });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate(
        (node) => node instanceof HTMLImageElement && node.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "How model is determined", exact: true })
    .click();
  const explanation = page.getByRole("dialog");
  await expect(
    explanation.getByText("Source evidence", { exact: true }),
  ).toBeVisible();
  await expect(
    explanation.getByText(support.reasoning, { exact: true }),
  ).toBeVisible();
  await expect(
    explanation.getByText(
      `Selected variant: ${support.selectedVariant.identity}`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    explanation.getByRole("link").filter({ hasText: /^RUN-/u }),
  ).toHaveAttribute("href", /^\/runs\/RUN-/u);
  await expect(
    explanation.getByRole("link").and(page.locator(`[href='${pageURL}']`)),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const shipment = await original(
    "Synthetic fan shipment",
    "Example Works shipped order SYNTHETIC-410: Example Works portable fan — small, blue. Tracking SYNTHETIC-TRACK-410. This is an update to the existing order, not a second purchase.",
  );
  await agent.configure({
    purposeSteps: { product_enrichment: productSteps },
    steps: [
      step("shipment-next", "work_next"),
      step("shipment-read", "mail_read", {
        workRef: from("shipment-next", "work.workRef"),
        messageRef: from("shipment-next", "work.sources.0.messageRef"),
      }),
      step("shipment-resolve", "work_resolve", {
        workRef: from("shipment-next", "work.workRef"),
        status: "verified",
        identity: {
          evidenceIds: [from("shipment-read", "evidenceId")],
          reasoning:
            "The retained shipment identifies the existing seller and exact order SYNTHETIC-410.",
        },
        emailLinks: [
          {
            purchaseRef: bought.shortcode,
            sourceRefs: [from("shipment-read", "evidenceId")],
            reasoning:
              "The original shipment updates the existing SYNTHETIC-410 order and supplies its tracking reference.",
            event: "shipped",
          },
        ],
        detail: "Attached the original shipment to the existing Purchase.",
      }),
    ],
    assessments: [
      productAssessment,
      {
        match: "original shipment updates the existing",
        output: {
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedOrders: [],
          acceptedEmailLinks: [0],
          rejected: [],
        },
      },
    ],
  });
  await admitOriginal(shipment);
  await gotoAuthenticatedPage(
    page,
    `/vendors/${seller.shortcode}`,
    page.getByText(shipment.subject, { exact: true }),
  );
  await expect
    .poll(
      async () => {
        const [event] = await database
          .select({ purchaseId: schema.orderMailCandidateDecision.purchaseId })
          .from(schema.orderMailEvent)
          .innerJoin(
            schema.orderMailCandidateDecision,
            eq(
              schema.orderMailCandidateDecision.eventId,
              schema.orderMailEvent.id,
            ),
          )
          .where(
            and(
              eq(schema.orderMailEvent.orderMailId, shipment.id),
              eq(schema.orderMailEvent.event, "shipped"),
              eq(schema.orderMailCandidateDecision.decision, "linked"),
            ),
          );
        return event?.purchaseId;
      },
      { timeout: 30_000 },
    )
    .toBe(bought.id);
  expect(
    await database
      .select()
      .from(schema.expense)
      .where(eq(schema.expense.purchaseId, bought.id)),
  ).toEqual(financialBefore);
  expect(
    await database
      .select()
      .from(schema.purchase)
      .where(eq(schema.purchase.vendorId, seller.id)),
  ).toHaveLength(1);
  expect(
    await database
      .select()
      .from(schema.inventoryEntry)
      .where(eq(schema.inventoryEntry.productId, item.id)),
  ).toEqual([]);
  await gotoAuthenticatedPage(page, `/purchases/${bought.shortcode}`);
  await expect(
    page.getByRole("link", { name: "Open Gmail original" }),
  ).toHaveCount(2);
  await expect(page.getByText(shipment.subject, { exact: true })).toBeVisible();
  await expect
    .poll(async () =>
      (
        await database
          .select({ status: schema.run.status })
          .from(schema.run)
          .where(eq(schema.run.purpose, "product_enrichment"))
      ).map((row) => row.status),
    )
    .toEqual(["completed", "completed"]);
  expect(await agent.violations()).toEqual([]);
});
