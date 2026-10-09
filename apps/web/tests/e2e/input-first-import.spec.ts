import { prepareCapturedRetailerOrder } from "./prepare-retailer-source";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import * as schema from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { resolveProductIdentifierSource } from "~/server/repo/product-identifier-source";
import { setMemberLoginParty } from "~/server/repo/member-login";
import { account as googleAccount } from "~/server/db/auth.schema";
import { createGmailApiClient } from "~/server/purchase-import/gmail/client";
import {
  convergenceNames,
  createConvergenceFixtures,
  ingestGmailEvidence,
  sha256Hex,
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

test.use({ workerdProfile: "gmail" });

// Failure boundaries: OAuth callback must persist its real account, mailbox
// original acquisition must use its stored credentials and actual MIME evidence, conflicting identities must
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
    // Exact identifiers use the canonical Vendor's issuer, not a legacy name slug.
    const identifierSource = await resolveProductIdentifierSource(db, {
      vendorId,
    });
    const product = await createEntityFixture(page, "product", {
      name: names.productName,
      categoryId: prerequisites.productCategory.id,
      externalIds: [
        {
          source: identifierSource,
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
        {
          source: identifierSource,
          kind: "asin",
          externalId: asin,
          isPrimary: true,
        },
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
    const connected = await database.query.account.findFirst({
      where: and(
        eq(googleAccount.userId, actor.userId),
        eq(googleAccount.providerId, "google"),
      ),
    });
    if (!connected?.accessToken)
      throw new Error("Google callback did not retain its access token");
    const client = createGmailApiClient({
      accessToken: connected.accessToken,
      baseUrl: `${provider.url}/gmail/v1/`,
    });
    const discovered = await client.listMessages({
      query: "-in:spam -in:trash",
    });
    expect(discovered.messages?.map((message) => message.id)).toContain(
      names.messageId,
    );
    const researchMail = await ingestGmailEvidence(db, member.id, names, {
      client,
      mailboxId: connected.accountId,
    });
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
        const purchasePicker = page.getByRole("combobox", {
          name: "Existing purchase",
          exact: true,
        });
        await expect(async () => {
          await purchasePicker.click();
          await expect(purchasePicker).toHaveAttribute("aria-expanded", "true");
        }).toPass({ timeout: 5000 });
        await purchasePicker.fill(purchaseCode);
        await page
          .getByRole("option", {
            name: new RegExp(`^${escapeRegExp(names.orderId)}`),
          })
          .click();
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
      const allowed = await page.request.patch(
        `/api/v1/vendors/${prerequisites.vendor.id}`,
        {
          headers: { Origin: e2eRuntime.baseURL },
          data: { browserDomains: [names.host, "www.amazon.com"] },
        },
      );
      expect(allowed.ok(), await allowed.text()).toBe(true);
      const run = await prepareCapturedRetailerOrder({
        page,
        db,
        actor,
        runtime: e2eRuntime,
        ledgerPartyId: member.id,
        vendorAccountId: accountId,
        accountCode: prerequisites.account.id,
        targetPurchaseId: purchaseCode,
        token,
        url,
        productUrl,
        expectedProductText: asin,
        retailerPages: {
          [url]: html,
          [productUrl]: `<title>${names.productName}</title><main>${names.productName} SKU ${sku} ASIN ${asin} USD 42.50</main>`,
        },
      });
      await gotoAuthenticatedPage(page, `/runs/${run.publicId}`);
      const approve = page.getByRole("button", {
        name: "Approve and import",
        exact: true,
      });
      await expect(
        page.locator("#import-prepared-orders").getByText("Exact identifier", {
          exact: true,
        }),
      ).toHaveCount(2);
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
    if (!purchaseCode) throw new Error("Supported imports created no Purchase");
    await researchMail(purchaseCode);

    await gotoAuthenticatedPage(page, `/vendors/${prerequisites.vendor.id}`);
    const mail = page
      .locator("#order-mail")
      .getByRole("listitem")
      .filter({
        has: page.getByText(`Order ${names.orderId}`, { exact: true }),
      });
    // Exact-order mail is already linked before following its canonical Purchase.
    const purchaseLink = mail.getByRole("link", {
      name: purchaseCode,
      exact: true,
    });
    await expect(purchaseLink).toBeVisible();
    await expect(purchaseLink).toHaveAttribute(
      "href",
      `/purchases/${purchaseCode}`,
    );
    const documentOrigin = await page.evaluate(() => performance.timeOrigin);
    await purchaseLink.click();
    await expect(page).toHaveURL(new RegExp(`/purchases/${purchaseCode}$`));
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(
      documentOrigin,
    );
    const originalMail = page.getByRole("link", {
      name: "Open Gmail original",
      exact: true,
    });
    await expect(originalMail).toBeVisible();
    await expect(originalMail).toHaveAttribute(
      "href",
      `https://mail.google.com/mail/u/0/#all/synthetic-thread-${token}`,
    );
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
    expect(ids.map((item) => item.source)).toEqual([
      identifierSource,
      identifierSource,
    ]);
    expect(provider.events()).toEqual(
      expect.arrayContaining([
        "GET /authorize",
        "POST /token",
        "GET /jwks",
        "GET /gmail/v1/users/me/messages",
        `GET /gmail/v1/users/me/messages/${names.messageId}`,
        "POST /model/extract-capture",
      ]),
    );
  });
}
