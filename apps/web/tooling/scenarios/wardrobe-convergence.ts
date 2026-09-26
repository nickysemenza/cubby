import { buildActorContext } from "@cubby/schemas/context";
import { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import { locationCreateInput } from "@cubby/schemas/location";
import {
  commitProductEnrichmentOut,
  commitPurchaseImportOut,
  overwriteProductEnrichmentOut,
  preparePurchaseImportOut,
} from "@cubby/schemas/purchase-import";
import { proposeProductMatchOut } from "@cubby/schemas/recommendations";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import { testUserId } from "@cubby/schemas/testing";
import { chromium, expect, request } from "@playwright/test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { z } from "zod";

import type { Database } from "~/server/db";

import { importRunsResponse } from "~/lib/purchase-import-run-detail";
import { callMcpTool } from "~/server/mcp/mcp-test-utils";
import { financialAccount } from "~/server/db/schema";
import { registerProductTools } from "~/server/mcp/tools/product.tools";
import { registerPurchaseTools } from "~/server/mcp/tools/purchase.tools";
import {
  startOrResumeImportRun,
  startTargetedImportRun,
} from "~/server/purchase-import/run-service";
import { classifyOrderCapture } from "~/server/purchase-import/order-list";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { productEnrichmentTarget } from "~/server/purchase-import/product-enrichment-target";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { recordStatementRows } from "~/server/repo/statement-row";
import { statementRowExternalId } from "~/server/repo/statement-row-identity";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { proposeProductMatch } from "~/server/services/product-match.service";

import {
  buildKernelContext,
  type KernelContext,
  buildScenarioDatabase,
  createFixtureWithContext,
} from "./context";

const photoName = "Synthetic Gray Crew Shirt";
const purchaseName = "Synthetic Heather Crew Tee";
const orderId = "111-2222222-3333333";
const matchEvidence =
  "The synthetic order's gray crew tee matches the photographed shirt and its label; the vendor Product has the purchase history.";

type ScenarioInput = {
  databaseURL: string;
  origin: string;
  artifacts: string;
  userId: string;
};

const syntheticOrder = z.object({
  orderNumber: z.string(),
  orderDate: z.iso.datetime(),
  seller: z.object({ name: z.string() }),
  priceCurrency: z.literal("USD"),
  price: z.number(),
  paymentMethodId: z.string(),
  orderStatus: z.string(),
});
const syntheticProduct = z.object({
  name: z.string(),
  url: z.url(),
  offers: z.object({ price: z.number(), priceCurrency: z.literal("USD") }),
});

async function readSyntheticRetailerEvidence() {
  const fixture = (name: string) =>
    new URL(`../../tests/e2e/fixtures/${name}`, import.meta.url);
  const history = fixture("synthetic-retailer-order-history.html");
  const orderPage = fixture("synthetic-retailer-order.html");
  const productPage = fixture("synthetic-retailer-product.html");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(history.href);
    const historyUrl = await page
      .locator('link[rel="canonical"]')
      .getAttribute("href");
    if (!historyUrl)
      throw new Error("Synthetic order history has no canonical URL");
    const links = await page.locator("a").evaluateAll((anchors) =>
      anchors.map((anchor, index) => ({
        id: String(index + 1),
        href: anchor instanceof HTMLAnchorElement ? anchor.href : "",
        text: anchor.textContent?.trim() ?? "",
      })),
    );
    const classified = classifyOrderCapture(
      {
        url: historyUrl,
        title: await page.title(),
        text: await page.locator("body").innerText(),
        links,
        images: [],
        capturedAt: "2026-09-21T00:00:00.000Z",
      },
      { allowedHosts: ["shop.example.test"] },
    );
    if (
      classified.kind !== "order_list" ||
      classified.orders.length !== 1 ||
      classified.orders[0]?.orderId !== orderId
    )
      throw new Error(
        `Synthetic order discovery failed: ${JSON.stringify(classified)}`,
      );
    await page.goto(orderPage.href);
    const order = syntheticOrder.parse(
      JSON.parse(
        (await page
          .locator('script[type="application/ld+json"]')
          .textContent()) ?? "",
      ),
    );
    const orderUrl = await page
      .locator('link[rel="canonical"]')
      .getAttribute("href");
    await page.goto(productPage.href);
    const product = syntheticProduct.parse(
      JSON.parse(
        (await page
          .locator('script[type="application/ld+json"]')
          .textContent()) ?? "",
      ),
    );
    if (
      !orderUrl ||
      classified.orders[0].orderUrl !== orderUrl ||
      order.orderNumber !== orderId ||
      product.name !== purchaseName ||
      order.price !== product.offers.price
    )
      throw new Error("Synthetic retailer pages disagree about the order");
    const sourceChecksum = createHash("sha256")
      .update(readFileSync(orderPage))
      .digest("hex");
    const evidenceChecksum = createHash("sha256")
      .update(readFileSync(orderPage))
      .update(readFileSync(productPage))
      .digest("hex");
    return { order, product, orderUrl, sourceChecksum, evidenceChecksum };
  } finally {
    await browser.close();
  }
}

async function readConvergenceFacts(
  pool: Pool,
  photoProductId: string,
  purchaseProductId: string,
) {
  const [products, inventory, expenses, attachments, purchases, settlements] =
    await Promise.all([
      pool.query<{ id: string; shortcode: string; deletedAt: Date | null }>(
        `SELECT id, shortcode, "deletedAt" FROM "Product" WHERE shortcode = ANY($1::text[])`,
        [[photoProductId, purchaseProductId]],
      ),
      pool.query<{
        productId: string;
        amount: { value: number; unit: string };
      }>(
        `SELECT "productId", amount FROM "InventoryEntry"
       WHERE "productId" IN (SELECT id FROM "Product" WHERE shortcode = ANY($1::text[]))
         AND "deletedAt" IS NULL`,
        [[photoProductId, purchaseProductId]],
      ),
      pool.query<{ productId: string; cost: string; purchaseId: string }>(
        `SELECT e."productId", e.cost::text AS cost, p.shortcode AS "purchaseId"
       FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId"
       WHERE p."orderId" = $1 AND e."deletedAt" IS NULL`,
        [orderId],
      ),
      pool.query<{
        imageId: string;
        subjectEntityId: string;
        purpose: string | null;
      }>(
        `SELECT i.shortcode AS "imageId", a."subjectEntityId", a.purpose
       FROM "EntityAttachment" a JOIN "Image" i ON i.id = a."imageId"
       WHERE a."subjectEntityId" IN (SELECT id FROM "Product" WHERE shortcode = ANY($1::text[]))
         AND a."deletedAt" IS NULL`,
        [[photoProductId, purchaseProductId]],
      ),
      pool.query<{ id: string; shortcode: string; statedTotal: string }>(
        `SELECT id, shortcode, "statedTotal"::text AS "statedTotal" FROM "Purchase"
       WHERE "orderId" = $1 AND "deletedAt" IS NULL`,
        [orderId],
      ),
      pool.query<{
        shortcode: string;
        purchaseId: string;
        amount: string;
        allocatedAmount: string;
        postedDate: string;
        transactionDate: string | null;
        sourceRefs: { source: string; externalId: string }[];
      }>(
        `SELECT t.shortcode, a."purchaseId", t.amount::text AS amount,
              a.amount::text AS "allocatedAmount", t."postedDate",
              t."transactionDate", t."sourceRefs"
       FROM "FinancialTransaction" t
       JOIN "FinancialTransactionAllocation" a ON a."transactionId" = t.id
       JOIN "Purchase" p ON p.id = a."purchaseId"
       WHERE p."orderId" = $1 AND t."deletedAt" IS NULL AND a."deletedAt" IS NULL`,
        [orderId],
      ),
    ]);
  return {
    products: products.rows,
    inventory: inventory.rows,
    expenses: expenses.rows,
    attachments: attachments.rows,
    purchases: purchases.rows,
    settlements: settlements.rows,
  };
}

type ConvergenceFacts = Awaited<ReturnType<typeof readConvergenceFacts>>;

function assertStatementSettlement(facts: ConvergenceFacts): void {
  if (
    facts.purchases.length !== 1 ||
    Number(facts.purchases[0]?.statedTotal) !== 29.99 ||
    facts.expenses[0]?.purchaseId !== facts.purchases[0]?.shortcode ||
    facts.settlements.length !== 1 ||
    facts.settlements[0]?.purchaseId !== facts.purchases[0]?.id ||
    Number(facts.settlements[0]?.amount) !== 29.99 ||
    Number(facts.settlements[0]?.allocatedAmount) !== 29.99 ||
    facts.settlements[0]?.transactionDate !== null ||
    facts.settlements[0]?.sourceRefs[0]?.source !== "monarch"
  )
    throw new Error(
      `Synthetic statement did not settle the Purchase: ${JSON.stringify(facts)}`,
    );
}

function assertBeforeMerge(
  facts: ConvergenceFacts,
  photoProductId: string,
  purchaseProductId: string,
): void {
  if (
    facts.products.length !== 2 ||
    facts.inventory.length !== 1 ||
    facts.inventory[0]?.productId !== photoProductId ||
    facts.expenses.length !== 1 ||
    facts.expenses[0]?.productId !== purchaseProductId ||
    Number(facts.expenses[0]?.cost) !== 29.99
  )
    throw new Error(
      `Purchase changed stock or spend unexpectedly: ${JSON.stringify(facts)}`,
    );
}

function assertAfterMerge(
  facts: ConvergenceFacts,
  purchaseProduct: { id: string; shortcode: string },
): void {
  const live = facts.products.filter((item) => item.deletedAt === null);
  const ownPhotos = facts.attachments.filter(
    (item) => item.subjectEntityId === purchaseProduct.id,
  );
  if (
    live.length !== 1 ||
    live[0]?.shortcode !== purchaseProduct.shortcode ||
    facts.inventory.length !== 1 ||
    facts.inventory[0]?.productId !== purchaseProduct.id ||
    facts.inventory[0]?.amount.value !== 1 ||
    facts.expenses.length !== 1 ||
    facts.expenses[0]?.productId !== purchaseProduct.id ||
    Number(facts.expenses[0]?.cost) !== 29.99 ||
    ownPhotos.length !== 2 ||
    !ownPhotos.some((item) => item.purpose === "label") ||
    !ownPhotos.some((item) => item.purpose === "item")
  )
    throw new Error(
      `Product merge lost photo, stock, or spend: ${JSON.stringify(facts)}`,
    );
  assertStatementSettlement(facts);
}

async function reviewMatchInBrowser(input: {
  origin: string;
  artifacts: string;
  photoProductId: string;
}): Promise<void> {
  const { origin, artifacts, photoProductId } = input;
  const api = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  try {
    const login = await api.post("/api/auth/sign-in/email", {
      data: {
        email: "sim@cubby.localhost",
        password: "cubby-sim-local-only",
      },
    });
    if (!login.ok())
      throw new Error(`Match review sign-in failed: ${await login.text()}`);
    const state = await api.storageState();
    state.cookies = state.cookies.filter(
      (cookie) => !cookie.name.endsWith("session_data"),
    );
    const browser = await chromium.launch();
    try {
      const browserContext = await browser.newContext({
        storageState: state,
        viewport: { width: 1280, height: 900 },
        recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } },
      });
      const page = await browserContext.newPage();
      try {
        await page.goto(
          `${origin}/recommendations/workbench?kind=product-match&source=${photoProductId}`,
        );
        const card = page.getByRole("article", {
          name: `${purchaseName} and ${photoName}`,
        });
        await expect(card).toBeVisible();
        await expect(
          card.getByText("Agent proposal", { exact: true }),
        ).toBeVisible();
        await expect(
          card.getByText(matchEvidence, { exact: true }),
        ).toBeVisible();
        await expect(
          card.getByText("Keep · From a purchase", { exact: true }),
        ).toBeVisible();
        await expect(
          card.getByText("Merge in · From a photo", { exact: true }),
        ).toBeVisible();
        await expect
          .poll(() =>
            card
              .getByRole("img", { name: photoName })
              .evaluate(
                (image) =>
                  image instanceof HTMLImageElement &&
                  image.complete &&
                  image.naturalWidth > 0,
              ),
          )
          .toBe(true);
        await card.getByRole("button", { name: "Review merge" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText(purchaseName);
        await expect(dialog).toContainText(photoName);
        await dialog
          .getByRole("button", { name: "Merge", exact: true })
          .click();
        await expect(card).toHaveCount(0);
        await expect(
          page.getByText("No product matches to review."),
        ).toBeVisible();
      } finally {
        await browserContext.close();
        const videoPath = await page.video()?.path();
        if (videoPath)
          console.log(
            `[headless-wardrobe-e2e] Match review video: ${videoPath}`,
          );
      }
    } finally {
      await browser.close();
    }
  } finally {
    await api.dispose();
  }
}

async function verifyJoinedProductInBrowser(input: {
  origin: string;
  artifacts: string;
  productId: string;
}) {
  const api = await request.newContext({
    baseURL: input.origin,
    extraHTTPHeaders: { Origin: input.origin },
  });
  try {
    const login = await api.post("/api/auth/sign-in/email", {
      data: { email: "sim@cubby.localhost", password: "cubby-sim-local-only" },
    });
    if (!login.ok())
      throw new Error(`Joined item sign-in failed: ${await login.text()}`);
    const state = await api.storageState();
    state.cookies = state.cookies.filter(
      (cookie) => !cookie.name.endsWith("session_data"),
    );
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        storageState: state,
        viewport: { width: 1280, height: 900 },
        recordVideo: {
          dir: input.artifacts,
          size: { width: 1280, height: 900 },
        },
      });
      const page = await context.newPage();
      try {
        await page.goto(`${input.origin}/products/${input.productId}`);
        await expect(
          page.getByRole("heading", { name: purchaseName, level: 1 }),
        ).toBeVisible();
        const finish = page.getByText("Finish this item").locator("..");
        await expect(finish).toContainText("2 own photos");
        await expect(finish).toContainText("Inventory recorded");
        await expect(finish).toContainText("Statement matched");
        await page.screenshot({
          path: `${input.artifacts}/joined-product.png`,
          fullPage: true,
        });
      } finally {
        await context.close();
        const videoPath = await page.video()?.path();
        if (videoPath)
          console.log(
            `[headless-wardrobe-e2e] Joined item video: ${videoPath}`,
          );
      }
    } finally {
      await browser.close();
    }
  } finally {
    await api.dispose();
  }
}

async function reviewLateChargeInBrowser(input: {
  origin: string;
  artifacts: string;
  purchaseId: string;
}) {
  const api = await request.newContext({
    baseURL: input.origin,
    extraHTTPHeaders: { Origin: input.origin },
  });
  try {
    const login = await api.post("/api/auth/sign-in/email", {
      data: { email: "sim@cubby.localhost", password: "cubby-sim-local-only" },
    });
    if (!login.ok())
      throw new Error(`Late charge sign-in failed: ${await login.text()}`);
    const state = await api.storageState();
    state.cookies = state.cookies.filter(
      (cookie) => !cookie.name.endsWith("session_data"),
    );
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        storageState: state,
        viewport: { width: 1280, height: 900 },
        recordVideo: {
          dir: input.artifacts,
          size: { width: 1280, height: 900 },
        },
      });
      const page = await context.newPage();
      try {
        const importRuns = page.waitForResponse((response) =>
          response.url().includes("/api/import/runs?purchaseId="),
        );
        await page.goto(`${input.origin}/purchases/${input.purchaseId}`);
        // The purchase import run that created this Purchase must list; a
        // response-schema drift here once turned the slot into a bare 500.
        const runsResponse = await importRuns;
        expect(runsResponse.status()).toBe(200);
        const { runs } = importRunsResponse.parse(await runsResponse.json());
        expect(runs.length).toBeGreaterThan(0);
        await expect(
          page.getByText("Purchase import runs could not load."),
        ).toHaveCount(0);
        await page
          .getByRole("button", { name: "Match a statement charge" })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "Match statement charge",
        });
        await expect(
          dialog.getByText("SYNTHETIC OUTFITTERS ORDER 1"),
        ).toBeVisible();
        await dialog
          .getByRole("button", { name: /SYNTHETIC OUTFITTERS ORDER 1/ })
          .click();
        await dialog.getByRole("button", { name: "Confirm match" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Match a statement charge" }),
        ).toHaveCount(0);
        // The matched charge must list in the settlement panel, not just clear
        // the match button (the panel once kept "No linked transactions").
        await expect(page.getByText("No linked transactions")).toHaveCount(0);
        await expect(page.getByText("1 financial transaction")).toBeVisible();
      } finally {
        await context.close();
        const videoPath = await page.video()?.path();
        if (videoPath)
          console.log(
            `[headless-wardrobe-e2e] Late charge review video: ${videoPath}`,
          );
      }
    } finally {
      await browser.close();
    }
  } finally {
    await api.dispose();
  }
}

async function importSyntheticMonarchCsv(
  pool: Pool,
  db: Database,
  userId: string,
  origin: string,
  artifacts: string,
): Promise<string> {
  const member = await pool.query<{ id: string }>(
    `SELECT id FROM "LedgerParty" WHERE "userId" = $1 AND kind = 'member' AND "deletedAt" IS NULL`,
    [userId],
  );
  const memberId = member.rows[0]?.id;
  if (member.rows.length !== 1 || !memberId)
    throw new Error("Synthetic member is unavailable for statement import");
  await insertWithShortcode(db, "financialAccount", {
    name: "Fixture Visa",
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    cardNumbers: [
      {
        last4: "4242",
        kind: "primary",
        validFrom: null,
        validTo: null,
        note: null,
      },
    ],
    sourceAliases: [
      {
        source: "monarch",
        alias: "Fixture Visa (...4242)",
        externalAccountId: null,
      },
    ],
    provisional: false,
  });
  const api = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  const csvPath = new URL(
    "../../tests/e2e/fixtures/synthetic-monarch-wardrobe.csv",
    import.meta.url,
  ).pathname;
  try {
    const login = await api.post("/api/auth/sign-in/email", {
      data: {
        email: "sim@cubby.localhost",
        password: "cubby-sim-local-only",
      },
    });
    if (!login.ok())
      throw new Error(`Statement review sign-in failed: ${await login.text()}`);
    const state = await api.storageState();
    state.cookies = state.cookies.filter(
      (cookie) => !cookie.name.endsWith("session_data"),
    );
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        storageState: state,
        viewport: { width: 1280, height: 900 },
        recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } },
      });
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/statement-rows/import`);
        const fileInput = page.getByLabel("Statement CSV file");
        await expect(fileInput).toBeEnabled();
        await fileInput.setInputFiles(csvPath);
        const preview = page.getByRole("region", { name: "Statement preview" });
        await expect(preview.getByText("Ready to record")).toHaveCount(2);
        await expect(preview).toContainText("Fixture Visa");
        await expect(preview).toContainText("monarch category: Clothing");
        await expect(preview).toContainText(
          "monarch category: Credit Card Payment",
        );
        await preview
          .getByRole("checkbox", {
            name: "Record SYNTHETIC OUTFITTERS ORDER 1",
          })
          .check();
        await expect(
          preview.getByRole("button", { name: "Choose transaction kinds" }),
        ).toBeDisabled();
        await preview
          .getByRole("combobox", {
            name: "Transaction kind for SYNTHETIC OUTFITTERS ORDER 1",
          })
          .selectOption("purchase");
        await preview
          .getByRole("button", {
            name: "Save rows and create 1 reviewed transactions",
          })
          .click();
        await expect(page.locator("output")).toContainText(
          "1 transactions created · 2 new source rows",
        );
        await expect(fileInput).toBeEnabled();
        await fileInput.setInputFiles(csvPath);
        await expect(preview.getByText("Already recorded")).toBeVisible();
        await preview
          .getByRole("button", { name: "Save 2 source rows" })
          .click();
        await expect(page.locator("output")).toContainText(
          "0 transactions created · 0 new source rows",
        );
      } finally {
        await context.close();
        const videoPath = await page.video()?.path();
        if (videoPath)
          console.log(
            `[headless-wardrobe-e2e] Statement review video: ${videoPath}`,
          );
      }
    } finally {
      await browser.close();
    }
  } finally {
    await api.dispose();
  }
  const recorded = await pool.query<{ shortcode: string }>(
    `SELECT shortcode FROM "FinancialTransaction"
     WHERE "sourceRefs" @> '[{"source":"monarch"}]'::jsonb AND "deletedAt" IS NULL`,
  );
  const statementRows = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "StatementRow" WHERE source = 'monarch'`,
  );
  if (recorded.rows.length !== 1 || statementRows.rows[0]?.count !== "2")
    throw new Error(
      "Replaying the synthetic Monarch CSV duplicated its evidence",
    );
  console.log(
    "[headless-wardrobe-e2e] Synthetic Monarch CSV browser preview, confirmation, evidence, and replay verified",
  );
  return recorded.rows[0]!.shortcode;
}

async function importSyntheticPurchase(
  pool: Pool,
  db: Database,
  kernel: KernelContext,
  userId: string,
  photoProduct: { id: string; shortcode: string },
): Promise<{ id: string; shortcode: string }> {
  const evidence = await readSyntheticRetailerEvidence();
  const member = await pool.query<{ id: string }>(
    `SELECT id FROM "LedgerParty" WHERE "userId" = $1 AND kind = 'member' AND "deletedAt" IS NULL`,
    [userId],
  );
  const memberId = member.rows[0]?.id;
  if (member.rows.length !== 1 || !memberId)
    throw new Error("Synthetic member is unavailable for purchase import");
  const vendor = await insertWithShortcode(db, "vendor", {
    name: "Synthetic Outfitters",
    website: "https://shop.example.test/orders",
    browserDomains: ["shop.example.test"],
  });
  const account = await insertWithShortcode(db, "vendorAccount", {
    label: "Synthetic wardrobe account",
    vendorId: vendor.id,
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
  });
  const run = await startOrResumeImportRun(db, {
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
    vendorAccountId: account.id,
    trigger: "manual",
  });
  const callPurchase = async (
    name: string,
    args: Parameters<typeof callMcpTool>[2],
  ) => {
    const server = new McpServer({
      name: "wardrobe-purchase-sim",
      version: "1.0",
    });
    registerPurchaseTools(server);
    const result = await callMcpTool(
      server,
      name,
      args,
      {},
      { entityKernel: kernel },
    );
    if (result.isError)
      throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
    return result.structuredContent;
  };
  const prepareOperationId = "prepare:synthetic-wardrobe-order";
  const prepared = preparePurchaseImportOut.parse(
    await callPurchase("prepare_purchase_import", {
      _runExecution: {
        runId: run.id,
        operationId: prepareOperationId,
        itemOperationIds: ["prepare-item:synthetic-wardrobe-order"],
      },
      orders: [
        {
          stableOrderId: "synthetic-wardrobe-order",
          itemOperationId: "prepare-item:synthetic-wardrobe-order",
          source: {
            kind: "browser_order",
            externalKey: evidence.orderUrl,
            checksum: evidence.sourceChecksum,
          },
          evidenceChecksum: evidence.evidenceChecksum,
          extractionRevision: "synthetic-html@1",
          extraction: {
            status: "ready",
            candidate: {
              orderId: evidence.order.orderNumber,
              orderedAt: evidence.order.orderDate,
              merchant: evidence.order.seller.name,
              currency: evidence.order.priceCurrency,
              printedGrandTotal: evidence.order.price,
              lines: [
                {
                  title: evidence.product.name,
                  amount: evidence.product.offers.price,
                  lineKind: "principal",
                  productUrl: evidence.product.url,
                },
              ],
              payments: [
                {
                  amount: evidence.order.price,
                  chargedAt: evidence.order.orderDate,
                  cardLastFour: evidence.order.paymentMethodId,
                },
              ],
              allShipmentsDelivered:
                evidence.order.orderStatus.endsWith("OrderDelivered"),
            },
          },
          lineIds: ["synthetic-wardrobe-order:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    }),
  );
  if (prepared.orders.length !== 1)
    throw new Error("Purchase preparation did not return the synthetic order");
  const beforeCommit = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "Purchase" WHERE "orderId" = $1 AND "deletedAt" IS NULL`,
    [orderId],
  );
  if (beforeCommit.rows[0]?.count !== "0")
    throw new Error("Purchase preparation wrote an order before commit");
  const committed = commitPurchaseImportOut.parse(
    await callPurchase("commit_purchase_import", {
      _runExecution: {
        runId: run.id,
        operationId: "commit:synthetic-wardrobe-order",
      },
      prepareOperationId,
      defaultTrade: "other",
      resolutions: [
        {
          stableOrderId: "synthetic-wardrobe-order",
          stableLineId: "synthetic-wardrobe-order:line-1",
          resolution: { kind: "new" },
        },
      ],
    }),
  );
  if (
    !["created", "updated", "replayed"].includes(
      committed.items[0]?.outcome ?? "",
    )
  )
    throw new Error(
      `Purchase commit did not settle the order: ${JSON.stringify(committed.items)}`,
    );
  const bought = await pool.query<{ id: string; shortcode: string }>(
    `SELECT p.id, p.shortcode FROM "Product" p
     JOIN "Expense" e ON e."productId" = p.id
     JOIN "Purchase" pu ON pu.id = e."purchaseId"
     WHERE pu."orderId" = $1 AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL`,
    [orderId],
  );
  const purchaseProduct = bought.rows[0];
  if (bought.rows.length !== 1 || !purchaseProduct)
    throw new Error("Purchase commit did not create one separate Product");
  const beforeMerge = await readConvergenceFacts(
    pool,
    photoProduct.shortcode,
    purchaseProduct.shortcode,
  );
  assertBeforeMerge(beforeMerge, photoProduct.id, purchaseProduct.id);
  return purchaseProduct;
}

async function syntheticWardrobeMemberAndVendor(pool: Pool, userId: string) {
  const member = await pool.query<{ id: string }>(
    `SELECT id FROM "LedgerParty" WHERE "userId" = $1 AND kind = 'member' AND "deletedAt" IS NULL`,
    [userId],
  );
  const memberId = member.rows[0]?.id;
  if (member.rows.length !== 1 || !memberId)
    throw new Error("Synthetic member is unavailable");
  const vendorRow = await pool.query<{ id: string }>(
    `SELECT id FROM "Vendor" WHERE name = 'Synthetic Outfitters' AND "deletedAt" IS NULL`,
  );
  const vendorId = vendorRow.rows[0]?.id;
  if (vendorRow.rows.length !== 1 || !vendorId)
    throw new Error("Synthetic vendor is unavailable");
  const account = await pool.query<{ id: string }>(
    `SELECT id FROM "VendorAccount" WHERE label = 'Synthetic wardrobe account' AND "deletedAt" IS NULL`,
  );
  const vendorAccountId = account.rows[0]?.id;
  if (account.rows.length !== 1 || !vendorAccountId)
    throw new Error("Synthetic vendor account is unavailable");
  return { memberId, vendorId, vendorAccountId };
}

/**
 * Re-import the identical order in a fresh run. A second run replaying the
 * exact same source evidence must be a true no-op — inventory never
 * auto-decrements/increments on re-import (README tenet), and re-running an
 * import must not mint a second Purchase or Expense for one order.
 */
async function reimportInNewRunAndAssertNoOp(
  pool: Pool,
  db: Database,
  kernel: KernelContext,
  userId: string,
  photoProduct: { id: string; shortcode: string },
  purchaseProduct: { id: string; shortcode: string },
): Promise<void> {
  const { memberId, vendorAccountId } = await syntheticWardrobeMemberAndVendor(
    pool,
    userId,
  );
  const evidence = await readSyntheticRetailerEvidence();
  const before = await readConvergenceFacts(
    pool,
    photoProduct.shortcode,
    purchaseProduct.shortcode,
  );
  const run = await startOrResumeImportRun(db, {
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
    vendorAccountId: parseEntityId("vendorAccount", vendorAccountId),
    trigger: "manual",
  });
  const callPurchase = async (
    name: string,
    args: Parameters<typeof callMcpTool>[2],
  ) => {
    const server = new McpServer({
      name: "wardrobe-reimport-sim",
      version: "1.0",
    });
    registerPurchaseTools(server);
    const result = await callMcpTool(
      server,
      name,
      args,
      {},
      { entityKernel: kernel },
    );
    if (result.isError)
      throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
    return result.structuredContent;
  };
  const prepareOperationId = "prepare:synthetic-wardrobe-order-reimport";
  const prepared = preparePurchaseImportOut.parse(
    await callPurchase("prepare_purchase_import", {
      _runExecution: {
        runId: run.id,
        operationId: prepareOperationId,
        itemOperationIds: ["prepare-item:synthetic-wardrobe-order-reimport"],
      },
      orders: [
        {
          stableOrderId: "synthetic-wardrobe-order-reimport",
          itemOperationId: "prepare-item:synthetic-wardrobe-order-reimport",
          source: {
            kind: "browser_order",
            externalKey: evidence.orderUrl,
            checksum: evidence.sourceChecksum,
          },
          evidenceChecksum: evidence.evidenceChecksum,
          extractionRevision: "synthetic-html@1",
          extraction: {
            status: "ready",
            candidate: {
              orderId: evidence.order.orderNumber,
              orderedAt: evidence.order.orderDate,
              merchant: evidence.order.seller.name,
              currency: evidence.order.priceCurrency,
              printedGrandTotal: evidence.order.price,
              lines: [
                {
                  title: evidence.product.name,
                  amount: evidence.product.offers.price,
                  lineKind: "principal",
                  productUrl: evidence.product.url,
                },
              ],
              payments: [
                {
                  amount: evidence.order.price,
                  chargedAt: evidence.order.orderDate,
                  cardLastFour: evidence.order.paymentMethodId,
                },
              ],
              allShipmentsDelivered:
                evidence.order.orderStatus.endsWith("OrderDelivered"),
            },
          },
          lineIds: ["synthetic-wardrobe-order-reimport:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    }),
  );
  if (prepared.orders.length !== 1)
    throw new Error("Re-import preparation did not return the synthetic order");
  const committed = commitPurchaseImportOut.parse(
    await callPurchase("commit_purchase_import", {
      _runExecution: {
        runId: run.id,
        operationId: "commit:synthetic-wardrobe-order-reimport",
      },
      prepareOperationId,
      defaultTrade: "other",
      resolutions: [
        {
          stableOrderId: "synthetic-wardrobe-order-reimport",
          stableLineId: "synthetic-wardrobe-order-reimport:line-1",
          resolution: {
            kind: "existing",
            productId: purchaseProduct.shortcode,
          },
        },
      ],
    }),
  );
  if (committed.items[0]?.outcome !== "replayed")
    throw new Error(
      `Re-importing identical evidence was not a pure replay: ${JSON.stringify(committed.items)}`,
    );
  const after = await readConvergenceFacts(
    pool,
    photoProduct.shortcode,
    purchaseProduct.shortcode,
  );
  if (
    after.purchases.length !== 1 ||
    after.expenses.length !== 1 ||
    JSON.stringify(before.purchases) !== JSON.stringify(after.purchases) ||
    JSON.stringify(before.expenses) !== JSON.stringify(after.expenses) ||
    JSON.stringify(before.inventory) !== JSON.stringify(after.inventory) ||
    JSON.stringify(before.settlements) !== JSON.stringify(after.settlements)
  )
    throw new Error(
      `Re-import in a new run changed converged state: ${JSON.stringify({ before, after })}`,
    );
  console.log(
    "[headless-wardrobe-e2e] Re-import in a new run replayed as a no-op: one Purchase, one Expense, inventory and allocations unchanged",
  );
}

/**
 * Trap 1 + 2: an overlapping statement CSV whose rows were already imported,
 * alongside a decoy charge sharing the purchase's exact amount on a different
 * day/merchant. Only the decoy row may be recorded; the overlap must not
 * mint a second StatementRow under a new batch. Returns the decoy
 * FinancialTransaction so the duplicate-order-history trap can confirm it
 * stays unmatched.
 */
async function recordOverlappingStatementCsvAndDecoy(
  db: Database,
  userId: string,
): Promise<{ id: string }> {
  const actor = buildActorContext(testUserId(userId), "mcp");
  const overlapAndDecoyRows = [
    {
      accountDescriptor: "Fixture Visa (...4242)",
      statementDate: "2026-09-21",
      providerAmount: -29.99,
      merchant: "Synthetic Outfitters",
      rawDescription: "SYNTHETIC OUTFITTERS ORDER 1",
    },
    {
      accountDescriptor: "Fixture Visa (...4242)",
      statementDate: "2026-09-22",
      providerAmount: 50,
      merchant: "Fixture Bank",
      rawDescription: "SYNTHETIC CARD PAYMENT",
    },
    {
      accountDescriptor: "Fixture Visa (...4242)",
      statementDate: "2026-08-05",
      providerAmount: -29.99,
      merchant: "Synthetic Deceptive Retail",
      rawDescription: "SYNTHETIC DECEPTIVE RETAIL CHARGE 1",
    },
  ] as const;
  const recorded = await recordStatementRows(
    db,
    recordStatementRowsInput.parse({
      import: {
        source: "monarch",
        label: "Synthetic wardrobe followup",
        fingerprint: "synthetic-wardrobe-followup-1",
        dateKind: "unknown",
        rowCountDeclared: overlapAndDecoyRows.length,
        notes: null,
      },
      rows: overlapAndDecoyRows,
      dryRun: false,
    }),
    actor,
  );
  if (
    recorded.inserted !== 1 ||
    recorded.alreadyInAnotherBatch !== 2 ||
    recorded.alreadyInThisBatch !== 0
  )
    throw new Error(
      `Overlapping statement CSV did not dedupe against already-imported rows: ${JSON.stringify(recorded)}`,
    );

  const fixtureVisa = await getDb(db)
    .select({ id: financialAccount.id })
    .from(financialAccount)
    .where(
      and(
        eq(financialAccount.name, "Fixture Visa"),
        notDeleted(financialAccount),
      ),
    );
  const fixtureVisaId = fixtureVisa[0]?.id;
  if (fixtureVisa.length !== 1 || !fixtureVisaId)
    throw new Error("Fixture Visa account is unavailable for the decoy charge");
  const decoyExternalId = await statementRowExternalId({
    source: "monarch",
    account: "Fixture Visa (...4242)",
    date: "2026-08-05",
    amount: -29.99,
    originalStatement: "SYNTHETIC DECEPTIVE RETAIL CHARGE 1",
  });
  return insertWithShortcode(db, "financialTransaction", {
    accountId: parseEntityId("financialAccount", fixtureVisaId),
    kind: "purchase",
    status: "posted",
    amount: 29.99,
    transactionDate: null,
    postedDate: "2026-08-05",
    merchant: "Synthetic Deceptive Retail",
    rawDescription: "SYNTHETIC DECEPTIVE RETAIL CHARGE 1",
    sourceCategory: "Clothing",
    sourceRefs: [{ source: "monarch", externalId: decoyExternalId }],
  });
}

/**
 * Trap 3: a duplicate order-history capture of the same order, under a
 * different source key (as a second discovery surface would produce). It
 * must attach to the existing Purchase rather than duplicate it, and its
 * conflicting line must be filed as a finding instead of a second Expense.
 */
async function commitDuplicateOrderHistoryCapture(
  db: Database,
  kernel: KernelContext,
  memberId: string,
  vendorAccountId: string,
  purchaseProduct: { shortcode: string },
) {
  const evidence = await readSyntheticRetailerEvidence();
  const run = await startOrResumeImportRun(db, {
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
    vendorAccountId: parseEntityId("vendorAccount", vendorAccountId),
    trigger: "manual",
  });
  const callPurchase = async (
    name: string,
    args: Parameters<typeof callMcpTool>[2],
  ) => {
    const server = new McpServer({ name: "wardrobe-trap-sim", version: "1.0" });
    registerPurchaseTools(server);
    const result = await callMcpTool(
      server,
      name,
      args,
      {},
      { entityKernel: kernel },
    );
    if (result.isError)
      throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
    return result.structuredContent;
  };
  const duplicateExternalKey = `${evidence.orderUrl}#duplicate-order-history-capture`;
  const duplicateChecksum = createHash("sha256")
    .update(duplicateExternalKey)
    .digest("hex");
  const prepareOperationId = "prepare:synthetic-wardrobe-order-duplicate";
  const prepared = preparePurchaseImportOut.parse(
    await callPurchase("prepare_purchase_import", {
      _runExecution: {
        runId: run.id,
        operationId: prepareOperationId,
        itemOperationIds: ["prepare-item:synthetic-wardrobe-order-duplicate"],
      },
      orders: [
        {
          stableOrderId: "synthetic-wardrobe-order-duplicate",
          itemOperationId: "prepare-item:synthetic-wardrobe-order-duplicate",
          source: {
            kind: "browser_order",
            externalKey: duplicateExternalKey,
            checksum: duplicateChecksum,
          },
          evidenceChecksum: duplicateChecksum,
          extractionRevision: "synthetic-html@1",
          extraction: {
            status: "ready",
            candidate: {
              orderId: evidence.order.orderNumber,
              orderedAt: evidence.order.orderDate,
              merchant: evidence.order.seller.name,
              currency: evidence.order.priceCurrency,
              printedGrandTotal: evidence.order.price,
              lines: [
                {
                  title: evidence.product.name,
                  amount: evidence.product.offers.price,
                  lineKind: "principal",
                  productUrl: evidence.product.url,
                },
              ],
              payments: [
                {
                  amount: evidence.order.price,
                  chargedAt: evidence.order.orderDate,
                  cardLastFour: evidence.order.paymentMethodId,
                },
              ],
              allShipmentsDelivered:
                evidence.order.orderStatus.endsWith("OrderDelivered"),
            },
          },
          lineIds: ["synthetic-wardrobe-order-duplicate:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    }),
  );
  if (prepared.orders.length !== 1)
    throw new Error(
      "Duplicate order-history preparation did not return the synthetic order",
    );
  const committed = commitPurchaseImportOut.parse(
    await callPurchase("commit_purchase_import", {
      _runExecution: {
        runId: run.id,
        operationId: "commit:synthetic-wardrobe-order-duplicate",
      },
      prepareOperationId,
      defaultTrade: "other",
      resolutions: [
        {
          stableOrderId: "synthetic-wardrobe-order-duplicate",
          stableLineId: "synthetic-wardrobe-order-duplicate:line-1",
          resolution: {
            kind: "existing",
            productId: purchaseProduct.shortcode,
          },
        },
      ],
    }),
  );
  if (
    committed.items[0]?.outcome !== "updated" ||
    (committed.items[0]?.findingCount ?? 0) < 1
  )
    throw new Error(
      `Duplicate order-history capture did not file a conflict finding: ${JSON.stringify(committed.items)}`,
    );
}

/**
 * ForgeWear traps: an overlapping statement CSV whose rows were already
 * imported, a decoy charge sharing the purchase's exact amount on a different
 * day/merchant, and a duplicate order-history capture of the same order under
 * a different source key. None may mint a duplicate Expense/Purchase or match
 * the decoy.
 */
async function runForgeWearTraps(
  pool: Pool,
  db: Database,
  kernel: KernelContext,
  userId: string,
  photoProduct: { id: string; shortcode: string },
  purchaseProduct: { id: string; shortcode: string },
): Promise<void> {
  const { memberId, vendorAccountId } = await syntheticWardrobeMemberAndVendor(
    pool,
    userId,
  );
  const decoyTransaction = await recordOverlappingStatementCsvAndDecoy(
    db,
    userId,
  );
  await commitDuplicateOrderHistoryCapture(
    db,
    kernel,
    memberId,
    vendorAccountId,
    purchaseProduct,
  );
  const facts = await readConvergenceFacts(
    pool,
    photoProduct.shortcode,
    purchaseProduct.shortcode,
  );
  const duplicateFinding = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "ImportFinding"
     WHERE "targetType" = 'purchase' AND "targetId" = $1 AND kind = 'duplicate_lines'`,
    [facts.purchases[0]?.id ?? null],
  );
  const decoyAllocations = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "FinancialTransactionAllocation"
     WHERE "transactionId" = $1 AND "deletedAt" IS NULL`,
    [decoyTransaction.id],
  );
  if (
    facts.purchases.length !== 1 ||
    facts.expenses.length !== 1 ||
    Number(facts.expenses[0]?.cost) !== 29.99 ||
    duplicateFinding.rows[0]?.count !== "1" ||
    decoyAllocations.rows[0]?.count !== "0"
  )
    throw new Error(
      `ForgeWear traps left inconsistent state: ${JSON.stringify({ facts, duplicateFinding: duplicateFinding.rows, decoyAllocations: decoyAllocations.rows })}`,
    );
  console.log(
    "[headless-wardrobe-e2e] ForgeWear traps held: overlapping statement rows deduped, the decoy charge stayed unmatched, and the duplicate order-history capture filed a conflict instead of a duplicate",
  );
}

async function productEnrichmentFingerprint(
  db: Database,
  productId: string,
): Promise<string> {
  const target = await productEnrichmentTarget(
    getDb(db),
    parseEntityId("product", productId),
  );
  if (!target) throw new Error("Product enrichment fingerprint target missing");
  return target.fingerprint;
}

/**
 * Product enrichment commit/overwrite: fill-only commit on a Product created
 * by this scenario, then a typed-approval overwrite of that same field.
 * Asserts the overwrite's stored value and that nothing else on the Product
 * changed.
 */
async function runProductEnrichmentCommitAndOverwrite(
  pool: Pool,
  db: Database,
  kernel: KernelContext,
  userId: string,
  purchaseProduct: { id: string; shortcode: string },
): Promise<void> {
  const { memberId, vendorId } = await syntheticWardrobeMemberAndVendor(
    pool,
    userId,
  );
  const callPurchase = async (
    name: string,
    args: Parameters<typeof callMcpTool>[2],
  ) => {
    const server = new McpServer({
      name: "wardrobe-enrichment-sim",
      version: "1.0",
    });
    registerPurchaseTools(server);
    const result = await callMcpTool(
      server,
      name,
      args,
      {},
      { entityKernel: kernel },
    );
    if (result.isError)
      throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
    return result.structuredContent;
  };

  const commitFingerprint = await productEnrichmentFingerprint(
    db,
    purchaseProduct.id,
  );
  const commitRun = await startTargetedImportRun(db, {
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
    purpose: "product_enrichment",
    vendorId: parseEntityId("vendor", vendorId),
    vendorAccountId: null,
    trigger: "manual",
    targets: [
      {
        kind: "product",
        productId: purchaseProduct.id,
        targetFingerprint: commitFingerprint,
      },
    ],
  });
  if (!commitRun.created)
    throw new Error("Product enrichment commit run was blocked");
  // Fill-only commits may only fill an empty field; the scenario's Product
  // already has a manufacturer from its import, so this fills `model`.
  const before = await pool.query<{
    manufacturer: string;
    model: string | null;
    categoryId: string | null;
  }>(`SELECT manufacturer, model, "categoryId" FROM "Product" WHERE id = $1`, [
    purchaseProduct.id,
  ]);
  if (before.rows[0]?.model !== null)
    throw new Error(
      `Enrichment setup expects an empty model: ${JSON.stringify(before.rows)}`,
    );
  const committed = commitProductEnrichmentOut.parse(
    await callPurchase("commit_product_enrichment", {
      _runExecution: {
        runId: commitRun.run.id,
        operationId: "commit:synthetic-wardrobe-enrichment",
      },
      productId: purchaseProduct.shortcode,
      targetFingerprint: commitFingerprint,
      changes: { model: "SYN-APRON-1" },
    }),
  );
  if (!committed.changedFields.includes("model"))
    throw new Error(
      `Enrichment commit did not fill model: ${JSON.stringify(committed)}`,
    );
  const afterCommit = await pool.query<{
    manufacturer: string;
    model: string | null;
    categoryId: string | null;
  }>(`SELECT manufacturer, model, "categoryId" FROM "Product" WHERE id = $1`, [
    purchaseProduct.id,
  ]);
  if (
    afterCommit.rows[0]?.model !== "SYN-APRON-1" ||
    afterCommit.rows[0]?.manufacturer !== before.rows[0]?.manufacturer
  )
    throw new Error(
      `Enrichment commit left unexpected state: ${JSON.stringify({ before: before.rows[0], after: afterCommit.rows[0] })}`,
    );

  const overwriteFingerprint = await productEnrichmentFingerprint(
    db,
    purchaseProduct.id,
  );
  const overwriteRun = await startTargetedImportRun(db, {
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
    purpose: "product_enrichment",
    vendorId: parseEntityId("vendor", vendorId),
    vendorAccountId: null,
    trigger: "manual",
    targets: [
      {
        kind: "product",
        productId: purchaseProduct.id,
        targetFingerprint: overwriteFingerprint,
      },
    ],
  });
  if (!overwriteRun.created)
    throw new Error("Product enrichment overwrite run was blocked");
  const overwritten = overwriteProductEnrichmentOut.parse(
    await callPurchase("overwrite_product_enrichment", {
      _runExecution: {
        runId: overwriteRun.run.id,
        operationId: "overwrite:synthetic-wardrobe-enrichment",
      },
      productId: purchaseProduct.shortcode,
      targetFingerprint: overwriteFingerprint,
      change: { field: "model", value: "SYN-APRON-2" },
    }),
  );
  if (overwritten.changedField !== "model")
    throw new Error(
      `Enrichment overwrite changed the wrong field: ${JSON.stringify(overwritten)}`,
    );
  const afterOverwrite = await pool.query<{
    manufacturer: string;
    model: string | null;
    categoryId: string | null;
  }>(`SELECT manufacturer, model, "categoryId" FROM "Product" WHERE id = $1`, [
    purchaseProduct.id,
  ]);
  const row = afterOverwrite.rows[0];
  if (
    !row ||
    row.model !== "SYN-APRON-2" ||
    row.manufacturer !== afterCommit.rows[0]?.manufacturer ||
    row.categoryId !== afterCommit.rows[0]?.categoryId
  )
    throw new Error(
      `Enrichment overwrite left unexpected state: ${JSON.stringify({ before: afterCommit.rows[0], after: row })}`,
    );
  console.log(
    "[headless-wardrobe-e2e] Product enrichment commit filled model, and overwrite replaced it with typed approval leaving other fields untouched",
  );
}

export async function runWardrobeConvergenceScenario({
  databaseURL,
  origin,
  artifacts,
  userId,
}: ScenarioInput): Promise<void> {
  const pool = new Pool({ connectionString: databaseURL });
  try {
    const db = buildScenarioDatabase(pool);
    const kernel = buildKernelContext(db, testUserId(userId));
    const photo = await pool.query<{ id: string; shortcode: string }>(
      `SELECT id, shortcode FROM "Product" WHERE name = $1 AND "deletedAt" IS NULL`,
      [photoName],
    );
    const photoProduct = photo.rows[0];
    if (photo.rows.length !== 1 || !photoProduct)
      throw new Error("Photo review did not leave one synthetic shirt Product");

    await insertWithShortcode(db, "location", {
      name: "Home",
      aliases: [],
      tags: [],
      type: "house",
      parentId: null,
    });
    const wardrobe = await createFixtureWithContext(
      kernel,
      "location",
      locationCreateInput.parse({
        name: "Synthetic Wardrobe Room",
        aliases: [],
        tags: [],
        type: "room",
      }),
    );
    await createFixtureWithContext(
      kernel,
      "inventory",
      inventoryCreatePayloadData.parse({
        productId: photoProduct.shortcode,
        locationId: wardrobe.id,
        amount: { value: 1, unit: "each" },
      }),
    );
    const purchaseProduct = await importSyntheticPurchase(
      pool,
      db,
      kernel,
      userId,
      photoProduct,
    );
    const beforeStatement = await readConvergenceFacts(
      pool,
      photoProduct.shortcode,
      purchaseProduct.shortcode,
    );
    if (beforeStatement.settlements.length)
      throw new Error(
        "Purchase import invented a statement settlement before CSV upload",
      );
    const statementTransactionId = await importSyntheticMonarchCsv(
      pool,
      db,
      userId,
      origin,
      artifacts,
    );
    const afterStatement = await readConvergenceFacts(
      pool,
      photoProduct.shortcode,
      purchaseProduct.shortcode,
    );
    if (afterStatement.settlements.length)
      throw new Error("A late statement charge was allocated without review");
    await reviewLateChargeInBrowser({
      origin,
      artifacts,
      purchaseId: afterStatement.purchases[0]!.shortcode,
    });
    assertStatementSettlement(
      await readConvergenceFacts(
        pool,
        photoProduct.shortcode,
        purchaseProduct.shortcode,
      ),
    );

    const proposalServer = new McpServer({
      name: "wardrobe-match-sim",
      version: "1.0",
    });
    registerProductTools(proposalServer);
    const proposed = await callMcpTool(
      proposalServer,
      "propose_product_match",
      {
        productIds: [photoProduct.shortcode, purchaseProduct.shortcode],
        evidence: matchEvidence,
        sourceUrls: ["https://shop.example.test/products/crew-tee"],
      },
      {
        recommendations: {
          proposeProductMatch: (input) => proposeProductMatch(db, input),
        },
      },
      { entityKernel: kernel },
    );
    if (
      proposed.isError ||
      proposeProductMatchOut.parse(proposed.structuredContent).state !== "open"
    )
      throw new Error(
        `Product match proposal failed: ${JSON.stringify(proposed.content)}`,
      );

    await reviewMatchInBrowser({
      origin,
      artifacts,
      photoProductId: photoProduct.shortcode,
    });

    const afterMerge = await readConvergenceFacts(
      pool,
      photoProduct.shortcode,
      purchaseProduct.shortcode,
    );
    assertAfterMerge(afterMerge, purchaseProduct);
    if (afterMerge.settlements[0]?.shortcode !== statementTransactionId)
      throw new Error(
        "Purchase settled against the wrong statement transaction",
      );
    await verifyJoinedProductInBrowser({
      origin,
      artifacts,
      productId: purchaseProduct.shortcode,
    });
    console.log(
      "[headless-wardrobe-e2e] Product, inventory, purchase, expense, Monarch transaction, and photos linked",
    );

    await reimportInNewRunAndAssertNoOp(
      pool,
      db,
      kernel,
      userId,
      photoProduct,
      purchaseProduct,
    );
    await runForgeWearTraps(
      pool,
      db,
      kernel,
      userId,
      photoProduct,
      purchaseProduct,
    );
    await runProductEnrichmentCommitAndOverwrite(
      pool,
      db,
      kernel,
      userId,
      purchaseProduct,
    );
  } finally {
    await pool.end();
  }
}
