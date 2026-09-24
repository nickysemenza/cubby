import { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
  financialTransactionCreateInput,
} from "@cubby/schemas/financial-transaction";
import { locationCreateInput } from "@cubby/schemas/location";
import {
  commitPurchaseImportOut,
  preparePurchaseImportOut,
} from "@cubby/schemas/purchase-import";
import { proposeProductMatchOut } from "@cubby/schemas/recommendations";
import { testUserId } from "@cubby/schemas/testing";
import { chromium, expect, request } from "@playwright/test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse } from "csv-parse/sync";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { z } from "zod";

import type { Database } from "~/server/db";

import { callMcpTool } from "~/server/mcp/mcp-test-utils";
import { registerFinancialTools } from "~/server/mcp/tools/financial.tools";
import { registerProductTools } from "~/server/mcp/tools/product.tools";
import { registerPurchaseTools } from "~/server/mcp/tools/purchase.tools";
import { startOrResumeImportRun } from "~/server/purchase-import/run-service";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { previewFinancialStatementImport } from "~/server/repo/financial-statement-preview";
import { proposeProductMatch } from "~/server/services/product-match.service";

import {
  buildKernelContext,
  type KernelContext,
  buildScenarioDatabase,
  createFixtureWithContext,
} from "./context";

const photoName = "Synthetic Gray Crew Shirt";
const purchaseName = "Synthetic Heather Crew Tee";
const orderId = "SYNTHETIC-WARDROBE-ORDER-1";
const matchEvidence =
  "The synthetic order's gray crew tee matches the photographed shirt and its label; the vendor Product has the purchase history.";

const monarchRow = z.strictObject({
  Date: z.string().min(1),
  Merchant: z.string().min(1),
  Category: z.string(),
  Account: z.string().min(1),
  "Original Statement": z.string().min(1),
  Notes: z.string(),
  Amount: z.string().min(1),
  Tags: z.string(),
  Owner: z.string(),
  Reviewed: z.string(),
  Id: z.string().min(1),
});

type ScenarioInput = {
  databaseURL: string;
  origin: string;
  artifacts: string;
  userId: string;
};

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
  assertStatementSettlement(facts);
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

async function importSyntheticMonarchCsv(
  pool: Pool,
  db: Database,
  kernel: KernelContext,
  userId: string,
): Promise<string> {
  const member = await pool.query<{ id: string }>(
    `SELECT id FROM "LedgerParty" WHERE "userId" = $1 AND kind = 'member' AND "deletedAt" IS NULL`,
    [userId],
  );
  const memberId = member.rows[0]?.id;
  if (member.rows.length !== 1 || !memberId)
    throw new Error("Synthetic member is unavailable for statement import");
  const csv = readFileSync(
    new URL(
      "../../tests/e2e/fixtures/synthetic-monarch-wardrobe.csv",
      import.meta.url,
    ),
    "utf8",
  );
  const parsed = z
    .array(monarchRow)
    .nonempty()
    .parse(parse(csv, { columns: true, bom: true, skip_empty_lines: true }));
  const input = financialStatementImportPreviewInput.parse({
    rows: parsed.map((row) => ({
      key: row.Id,
      source: "monarch",
      account: row.Account,
      date: row.Date,
      amount: Number(row.Amount),
      merchant: row.Merchant,
      originalStatement: row["Original Statement"],
      category: row.Category || null,
      notes: row.Notes || null,
    })),
  });
  const account = await insertWithShortcode(db, "financialAccount", {
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
  const server = new McpServer({
    name: "wardrobe-statement-sim",
    version: "1.0",
  });
  registerFinancialTools(server);
  const preview = async () => {
    const result = await callMcpTool(
      server,
      "preview_financial_statement_import",
      input,
      {
        financialTransaction: {
          previewStatementImport: (data) =>
            previewFinancialStatementImport(db, data),
        },
      },
      { entityKernel: kernel },
    );
    if (result.isError)
      throw new Error(
        `Monarch preview failed: ${JSON.stringify(result.content)}`,
      );
    return financialStatementImportPreviewOut.parse(result.structuredContent);
  };
  const first = await preview();
  const row = first.rows[0];
  if (
    first.rows.length !== 1 ||
    row?.status !== "ready_to_create" ||
    row.accountId !== account.shortcode
  )
    throw new Error(
      `Synthetic Monarch row was not ready: ${JSON.stringify(first)}`,
    );
  const proposed = row.proposed;
  const transaction = await createFixtureWithContext(
    kernel,
    "financialTransaction",
    financialTransactionCreateInput.parse({
      accountId: row.accountId,
      purchaseId: null,
      kind: proposed.kind,
      status: proposed.status,
      amount: proposed.amount,
      transactionDate: proposed.transactionDate,
      postedDate: proposed.postedDate,
      merchant: proposed.merchant,
      rawDescription: proposed.rawDescription,
      sourceCategory: proposed.sourceCategory,
      sourceRefs: [proposed.sourceRef],
      notes: proposed.notes,
    }),
  );
  const transactionCode = parseShortcodeFor(
    "financialTransaction",
    transaction.id,
  );
  const replay = await preview();
  if (
    replay.rows[0]?.status !== "already_recorded" ||
    !replay.rows[0].existingTransactionIds.includes(transactionCode)
  )
    throw new Error(
      "Replaying the synthetic Monarch CSV duplicated its charge",
    );
  console.log(
    "[headless-wardrobe-e2e] Synthetic Monarch CSV preview, approval, and source-ref replay verified",
  );
  return transactionCode;
}

async function importSyntheticPurchase(
  pool: Pool,
  db: Database,
  kernel: KernelContext,
  userId: string,
  photoProduct: { id: string; shortcode: string },
): Promise<{ id: string; shortcode: string }> {
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
            externalKey: "shop.example.test:order:synthetic-wardrobe-1",
            checksum: "a".repeat(64),
          },
          evidenceChecksum: "b".repeat(64),
          extractionRevision: "synthetic@1",
          extraction: {
            status: "ready",
            candidate: {
              orderId,
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Synthetic Outfitters",
              currency: "USD",
              printedGrandTotal: 29.99,
              lines: [
                {
                  title: purchaseName,
                  amount: 29.99,
                  lineKind: "principal",
                  productUrl: "https://shop.example.test/products/crew-tee",
                },
              ],
              payments: [
                {
                  amount: 29.99,
                  chargedAt: "2026-09-20T12:00:00.000Z",
                  cardLastFour: "4242",
                },
              ],
              allShipmentsDelivered: true,
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

    const wardrobe = await createFixtureWithContext(
      kernel,
      "location",
      locationCreateInput.parse({
        name: "Synthetic Wardrobe Room",
        aliases: [],
        tags: [],
        type: "room",
        parentId: "LOC-HM3E",
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
    const statementTransactionId = await importSyntheticMonarchCsv(
      pool,
      db,
      kernel,
      userId,
    );
    const purchaseProduct = await importSyntheticPurchase(
      pool,
      db,
      kernel,
      userId,
      photoProduct,
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
    console.log(
      "[headless-wardrobe-e2e] Product, inventory, purchase, expense, Monarch transaction, and photos linked",
    );
  } finally {
    await pool.end();
  }
}
