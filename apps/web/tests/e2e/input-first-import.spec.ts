import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { preparePurchaseImportInput } from "@cubby/schemas/purchase-import";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import * as schema from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { setMemberLoginParty } from "~/server/repo/member-login";
import { preparePurchaseImport } from "~/server/purchase-import/import-orders";
import { extractPurchaseCapture } from "~/server/agents/purchase-import/extract";
import { connectRetailerBrowserPeer } from "./retailer-browser-peer";
import { startOrResumeRun } from "~/server/purchase-import/run-service";
import {
  convergenceNames,
  createConvergenceFixtures,
  sha256Hex,
  syntheticOrderIds,
} from "../../tooling/convergence-harness";
import {
  createEntityFixture,
  createEvidenceHarnessContext,
  ensureMemberParty,
} from "./fixtures-core";
import {
  escapeRegExp,
  gotoAuthenticatedPage,
  selectComboboxItem,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test.use({ gmailJourney: true });

// Failure boundaries: OAuth callback must persist its real account, mailbox
// discovery must classify actual MIME evidence, conflicting identities must
// require an explicit Product decision, and both arrivals must converge after
// reviewed booking/correction without another Product or economic line.
for (const statementFirst of [true, false]) {
  test(`input-first Google, ${statementFirst ? "statement then retailer" : "retailer then statement"}, and reviewed Product merge`, async ({
    page,
    e2eRuntime,
  }) => {
    test.setTimeout(180_000);
    const provider = e2eRuntime.googleProvider;
    if (!provider) throw new Error("Gmail journey requires its local provider");
    const providerURL = provider.url;
    const token = `joined-${Date.now()}`;
    const names = convergenceNames(token);
    const { db, actor } = await createEvidenceHarnessContext(page);
    const database = getDb(db);
    const member = await ensureMemberParty(page, names.name);
    await setMemberLoginParty(
      db,
      actor.userId,
      parseShortcodeFor("ledgerParty", member.shortcode),
      actor,
    );
    const prerequisites = await createConvergenceFixtures(
      (entity, overrides) => createEntityFixture(page, entity, overrides),
      member.shortcode,
      names,
    );
    const vendorId = await resolveOrThrow(
      db,
      "vendor",
      prerequisites.vendor.id,
    );
    const accountId = await resolveOrThrow(
      db,
      "vendorAccount",
      prerequisites.account.id,
    );
    const cardId = await resolveOrThrow(
      db,
      "financialAccount",
      prerequisites.card.id,
    );
    const asin = `B0${sha256Hex(`${token}:${statementFirst}`).slice(0, 8).toUpperCase()}`;
    const sku = `SYN-SKU-${token}`;
    const product = await createEntityFixture(page, "product", {
      name: names.productName,
      categoryId: prerequisites.productCategory.id,
      externalIds: [
        {
          source: "amazon",
          kind: "retailer_sku",
          externalId: sku,
          isPrimary: true,
        },
      ],
    });
    const duplicateName = `${names.productName} alternate listing`;
    const duplicate = await createEntityFixture(page, "product", {
      name: duplicateName,
      categoryId: prerequisites.productCategory.id,
      externalIds: [
        { source: "amazon", kind: "asin", externalId: asin, isPrimary: true },
      ],
    });
    const session = z
      .object({ user: z.object({ email: z.email() }) })
      .parse(await (await page.request.get("/api/auth/get-session")).json());
    provider.configure({
      email: session.user.email,
      message: {
        id: names.messageId,
        threadId: `synthetic-thread-${token}`,
        historyId: "1",
        internalDate: String(Date.parse("2026-09-10T12:30:00Z")),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: names.sender },
            { name: "Subject", value: `Order ${names.orderId}` },
          ],
          body: {
            data: Buffer.from(
              `Order ${names.orderId} placed. Total USD 42.50.`,
            ).toString("base64url"),
          },
        },
      },
      extraction: {
        url: `https://${names.host}/orders/${names.orderId}`,
        output: {
          status: "ready",
          reason: null,
          detail: null,
          candidate: {
            ...names.retailerCandidate,
            lines: [
              {
                title: names.productName,
                amount: 42.5,
                lineKind: "principal",
                sku,
                quantity: 1,
                productUrl: `https://www.amazon.com/dp/${asin}`,
                imageUrl: null,
                seller: null,
              },
            ],
          },
        },
      },
      classification: {
        events: [
          {
            event: "placed",
            orderId: names.orderId,
            amount: 42.5,
            currency: "USD",
            occurredAt: "2026-09-10T12:00:00.000Z",
          },
        ],
      },
    });
    await gotoAuthenticatedPage(page, "/settings");
    const disconnect = page.getByRole("button", {
      name: "Disconnect Google & Gmail",
      exact: true,
    });
    await expect(
      page.getByRole("button", {
        name: /^(?:Connect|Disconnect) Google & Gmail$/u,
      }),
    ).toBeEnabled();
    if (await disconnect.isVisible()) await disconnect.click();
    const connect = page.getByRole("button", {
      name: "Connect Google & Gmail",
      exact: true,
    });
    await expect(connect).toBeEnabled();
    await connect.click();
    await expect(
      page.getByRole("heading", { name: "Synthetic Google consent" }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Grant read-only Gmail access",
        exact: true,
      })
      .click();
    await expect(disconnect).toBeVisible();
    const accounts = z
      .array(
        z
          .object({
            providerId: z.string(),
            scopes: z.array(z.string()).optional(),
          })
          .loose(),
      )
      .parse(await (await page.request.get("/api/auth/list-accounts")).json());
    expect(accounts.some((account) => account.providerId === "google")).toBe(
      true,
    );
    await gotoAuthenticatedPage(page, `/vendors/${prerequisites.vendor.id}`);
    await page
      .getByRole("button", { name: "Search Gmail now", exact: true })
      .click();
    await expect(page.getByText(/Checked 1 messages/u)).toBeVisible({
      timeout: 60_000,
    });
    const searchRun = await page
      .getByRole("link", { name: "View run", exact: true })
      .getAttribute("href");
    if (!searchRun) throw new Error("Gmail discovery has no public Run review");
    await page.getByRole("link", { name: "View run", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(escapeRegExp(searchRun)));
    await expect(
      page.getByRole("heading", { name: /Run/u }).first(),
    ).toBeVisible();
    expect(
      await database.query.purchase.findMany({
        where: and(
          eq(schema.purchase.vendorId, vendorId),
          notDeleted(schema.purchase),
        ),
      }),
    ).toHaveLength(0);

    let purchaseCode: string | undefined;
    async function statement() {
      await gotoAuthenticatedPage(page, "/statement-rows/import");
      await page.getByLabel("Statement CSV file").setInputFiles({
        name: `${token}.csv`,
        mimeType: "text/csv",
        buffer: Buffer.from(names.statementCsv),
      });
      await expect(
        page.getByText(new RegExp(escapeRegExp(`${names.name} card`))).first(),
      ).toBeVisible();
      await page
        .getByRole("checkbox", {
          name: `Record SYNTHETIC ORDER ${token}`,
          exact: true,
        })
        .check();
      await page
        .getByLabel(`Transaction kind for SYNTHETIC ORDER ${token}`, {
          exact: true,
        })
        .selectOption("purchase");
      await page
        .getByRole("button", {
          name: "Save rows and create 1 reviewed transactions",
          exact: true,
        })
        .click();
      await expect(page.getByText(/1 transactions created/u)).toBeVisible();
      const transaction = await database.query.financialTransaction.findFirst({
        where: and(
          eq(schema.financialTransaction.accountId, cardId),
          notDeleted(schema.financialTransaction),
        ),
      });
      if (!transaction) throw new Error("CSV approval created no transaction");
      await gotoAuthenticatedPage(
        page,
        `/financial-transactions/${transaction.shortcode}`,
      );
      if (purchaseCode) {
        await selectComboboxItem(
          page,
          page.getByRole("combobox", {
            name: "Existing purchase",
            exact: true,
          }),
          purchaseCode,
          { query: purchaseCode, code: purchaseCode },
        );
      } else {
        await selectComboboxItem(
          page,
          page.getByRole("combobox", { name: "Vendor", exact: true }),
          names.name,
        );
        await selectComboboxItem(
          page,
          page.getByRole("combobox", {
            name: "Spending category",
            exact: true,
          }),
          `${names.name} clothing`,
        );
      }
      await page
        .getByRole("button", { name: "Review Expense", exact: true })
        .click();
      await expect(
        page.getByText(new RegExp(escapeRegExp(`${names.name} card`))).first(),
      ).toBeVisible();
      await page
        .getByRole("button", {
          name: purchaseCode ? "Link settlement" : "Record Expense",
          exact: true,
        })
        .click();
      await expect
        .poll(async () => {
          const purchase = await database.query.purchase.findFirst({
            where: and(
              eq(schema.purchase.vendorId, vendorId),
              notDeleted(schema.purchase),
            ),
          });
          purchaseCode = purchase?.shortcode;
          return purchaseCode;
        })
        .toBeTruthy();
    }
    const productId = await resolveOrThrow(db, "product", product.id);
    const aliasId = await resolveOrThrow(db, "product", duplicate.id);
    async function expectNoInventory() {
      expect(
        await database.query.inventoryEntry.findMany({
          where: notDeleted(schema.inventoryEntry),
        }),
      ).toHaveLength(0);
    }
    async function mergeReviewedProducts() {
      await expectNoInventory();
      const mergePage = await page.context().newPage();
      try {
        await gotoAuthenticatedPage(mergePage, "/products");
        for (const name of [names.productName, duplicateName]) {
          const row = mergePage.getByRole("row").filter({
            has: mergePage.getByRole("link", { name, exact: true }),
          });
          await row
            .getByRole("checkbox", { name: "Select row", exact: true })
            .check();
        }
        await mergePage
          .locator("[data-bulk-action-bar]")
          .getByRole("button", { name: "Merge", exact: true })
          .click();
        const dialog = mergePage.getByRole("dialog");
        await dialog
          .getByRole("button", {
            name: new RegExp(`^${escapeRegExp(names.productName)}(?:$|\\s)`),
          })
          .filter({ hasNotText: duplicateName })
          .click();
        await expect(
          dialog.getByRole("heading", {
            name: "What the merged product will keep",
            exact: true,
          }),
        ).toBeVisible();
        await dialog
          .getByRole("button", { name: "Merge", exact: true })
          .click();
        await expect(dialog).not.toBeVisible();
        await expectNoInventory();
      } finally {
        await mergePage.close();
      }
    }
    async function retailer() {
      const url = `https://${names.host}/orders/${names.orderId}`;
      const productUrl = `https://www.amazon.com/dp/${asin}`;
      const html = `<title>Synthetic order detail</title><main><h1>${names.orderId}</h1><p>Ordered September 10, 2026. Delivered.</p><p>USD 42.50</p><p>${names.productName} SKU ${sku} quantity 1</p><a href="${productUrl}">Product page</a></main>`;
      await page
        .context()
        .route(url, (route) =>
          route.fulfill({ contentType: "text/html", body: html }),
        );
      await page.context().route(productUrl, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<title>${names.productName}</title><main>${names.productName} SKU ${sku} ASIN ${asin} USD 42.50</main>`,
        }),
      );
      const allowed = await page.request.patch(
        `/api/v1/vendors/${prerequisites.vendor.id}`,
        {
          headers: { Origin: e2eRuntime.baseURL },
          data: { browserDomains: [names.host, "www.amazon.com"] },
        },
      );
      expect(allowed.ok(), await allowed.text()).toBe(true);
      const run = await startOrResumeRun(db, {
        ledgerPartyId: member.id,
        vendorAccountId: accountId,
        trigger: "manual",
      });
      const namespace = await e2eRuntime.browserNamespace();
      const peer = await connectRetailerBrowserPeer({
        page,
        db,
        namespace,
        baseURL: e2eRuntime.baseURL,
        accountCode: prerequisites.account.id,
        accountId,
        runId: run.id,
      });
      const ids = syntheticOrderIds(token);
      try {
        const captured = await peer.capture(url, `capture-order:${token}`);
        const capturedProduct = await peer.capture(
          productUrl,
          `capture-product:${token}`,
        );
        expect(capturedProduct.readableText).toContain(asin);
        const capture = {
          url: captured.sourceURL,
          title: captured.title,
          text: captured.readableText,
          capturedAt: captured.capturedAt,
          links: captured.links.map((link) => ({
            id: link.id,
            href: link.url,
            text: link.label ?? "",
          })),
          images: captured.images.map((image) => ({
            src: image.url,
            alt: image.alt ?? "",
          })),
        };
        const extraction = await extractPurchaseCapture(
          { db, runId: run.id, capture },
          {
            runStructured: async (feature) => {
              const response = await fetch(
                `${providerURL}/model/extract-capture`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(capture),
                },
              );
              if (!response.ok) throw new Error(await response.text());
              return feature.schema.parse(await response.json());
            },
          },
        );
        const checksum = sha256Hex(
          JSON.stringify({ captured, capturedProduct }),
        );
        await preparePurchaseImport(
          db,
          preparePurchaseImportInput.parse({
            _runExecution: {
              runId: run.id,
              operationId: ids.prepare,
              itemOperationIds: [ids.item],
            },
            orders: [
              {
                targetPurchaseId: purchaseCode,
                stableOrderId: ids.order,
                itemOperationId: ids.item,
                source: { kind: "browser_order", externalKey: url, checksum },
                evidenceChecksum: checksum,
                extractionRevision: "synthetic-provider@1",
                extraction,
                lineIds: [ids.line],
                primaryDocumentImageId: null,
                screenshotImageId: null,
              },
            ],
          }),
          actor,
        );
      } finally {
        await peer.close();
      }
      await gotoAuthenticatedPage(page, `/runs/${run.publicId}`);
      const approve = page.getByRole("button", {
        name: "Approve and import",
        exact: true,
      });
      await expect(
        page.getByText(
          "Conflicting exact matches. Choose the Product to use.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(approve).toBeDisabled();
      await page
        .getByLabel("Trade for imported expenses", { exact: true })
        .selectOption("other");
      await expect(approve).toBeDisabled();
      await page
        .getByRole("button", { name: `Use ${names.productName}`, exact: true })
        .click();
      await expect(approve).toBeEnabled();
      await mergeReviewedProducts();
      await approve.click();
      if (statementFirst) {
        const apply = page.getByRole("button", {
          name: "Apply fix",
          exact: true,
        });
        await expect(apply).toBeEnabled();
        await apply.click();
        await expect(
          page.getByText("Applied import correction", { exact: true }),
        ).toBeVisible();
      }
      await expect
        .poll(async () => {
          const purchase = await database.query.purchase.findFirst({
            where: and(
              eq(schema.purchase.vendorId, vendorId),
              eq(schema.purchase.orderId, names.orderId),
              notDeleted(schema.purchase),
            ),
          });
          purchaseCode = purchase?.shortcode;
          return purchaseCode;
        })
        .toBeTruthy();
    }
    if (statementFirst) {
      await statement();
      await retailer();
    } else {
      await retailer();
      await statement();
    }

    await gotoAuthenticatedPage(page, `/vendors/${prerequisites.vendor.id}`);
    const mail = page
      .getByRole("article")
      .filter({ hasText: `Order ${names.orderId}` });
    const match = mail
      .getByRole("link", { name: names.orderId, exact: true })
      .locator("..")
      .locator("..");
    await match.getByRole("button", { name: "Link", exact: true }).click();
    await expect(mail.getByText("linked", { exact: true })).toBeVisible();
    await gotoAuthenticatedPage(page, `/purchases/${purchaseCode}`);
    await expect(
      page.getByRole("link", { name: "Open Gmail conversation", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: names.productName, exact: true }).first(),
    ).toBeVisible();
    const purchases = await database.query.purchase.findMany({
      where: and(
        eq(schema.purchase.vendorId, vendorId),
        notDeleted(schema.purchase),
      ),
    });
    expect(purchases).toHaveLength(1);
    const expenses = await database.query.expense.findMany({
      where: and(
        eq(schema.expense.purchaseId, purchases[0]!.id),
        notDeleted(schema.expense),
      ),
    });
    expect(expenses).toMatchObject([{ productId, cost: 42.5 }]);
    await expectNoInventory();
    expect(
      await database.query.product.findMany({
        where: and(
          inArray(schema.product.id, [productId, aliasId]),
          notDeleted(schema.product),
        ),
      }),
    ).toHaveLength(1);
    const ids = await database.query.entityExternalId.findMany({
      where: and(
        eq(schema.entityExternalId.entityId, productId),
        notDeleted(schema.entityExternalId),
      ),
    });
    expect(ids.map((item) => item.kind).sort()).toEqual([
      "asin",
      "retailer_sku",
    ]);
    expect(provider.events()).toEqual(
      expect.arrayContaining([
        "GET /authorize",
        "POST /token",
        "GET /jwks",
        "GET /gmail/v1/users/me/messages",
        `GET /gmail/v1/users/me/messages/${names.messageId}`,
        "POST /model/classify-mail",
        "POST /model/extract-capture",
      ]),
    );
  });
}
