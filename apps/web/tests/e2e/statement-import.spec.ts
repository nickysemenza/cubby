import { z } from "zod";
import { createEntityFixture } from "./fixtures-core";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("a no-ID posted tip requires reviewed attachment to the pending charge", async ({
  page,
  baseURL,
}) => {
  const tag = `synthetic-tip-${Date.now()}`;
  await gotoAuthenticatedPage(page, "/statement-rows/import");
  const account = await createEntityFixture(page, "financialAccount", {
    name: tag,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    sourceAliases: [{ source: "copilot", alias: tag, externalAccountId: null }],
  });
  const pending = await page.request.post("/api/v1/financial-transactions", {
    headers: { Origin: baseURL! },
    data: {
      accountId: account.id,
      kind: "purchase",
      status: "pending",
      amount: 20,
      transactionDate: "2026-08-16",
      merchant: tag,
      rawDescription: tag,
    },
  });
  expect(pending.status(), await pending.text()).toBe(201);
  const transactionId = z
    .object({ item: z.object({ id: z.string() }) })
    .parse(await pending.json()).item.id;
  await page.getByLabel("Statement CSV file").setInputFiles({
    name: "posted-tip.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `date,name,amount,status,category,type,account,account mask,note\n2026-08-18,${tag},24,posted,Dining,regular,${tag},,`,
    ),
  });
  const candidate = page.getByLabel(`Attach existing transaction for ${tag}`, {
    exact: true,
  });
  await expect(candidate).toBeVisible();
  await expect(
    candidate.locator("option", { hasText: /20.00.+pending/ }),
  ).toHaveCount(1);
  await candidate.selectOption(transactionId);
  await page
    .getByRole("button", {
      name: "Save rows and attach 1 reviewed observations",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(/0 transactions created.*1 observations attached/),
  ).toBeVisible();
  const canonical = await page.request.get(
    `/api/v1/financial-transactions/${transactionId}`,
  );
  expect(
    z
      .object({
        amount: z.number(),
        status: z.string(),
        transactionDate: z.string(),
        postedDate: z.null(),
        sourceRefs: z.array(z.unknown()),
      })
      .parse(await canonical.json()),
  ).toMatchObject({
    amount: 20,
    status: "pending",
    transactionDate: "2026-08-16",
    postedDate: null,
    sourceRefs: [expect.anything()],
  });
});

test("full-size statement CSV saves in bounded batches and replays without duplicate rows", async ({
  page,
}) => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const csv = [
    "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id",
    ...Array.from(
      { length: 501 },
      (_, index) =>
        `9/21/2026,Synthetic Outfitters,Clothing,Fixture Visa,ORDER ${unique} ${index + 1},,-1.00,,,,row-${index + 1}`,
    ),
  ].join("\n");
  const upload = async () => {
    await page.getByLabel("Statement CSV file").setInputFiles({
      name: `fixture-${unique}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await expect(
      page.getByRole("heading", { name: /501 source rows/ }),
    ).toBeVisible();
  };

  await gotoAuthenticatedPage(page, "/statement-rows/import");
  await upload();
  await page.getByRole("button", { name: "Save 501 source rows" }).click();
  await expect(page.getByText("501 new source rows")).toBeVisible();

  await upload();
  await page.getByRole("button", { name: "Save 501 source rows" }).click();
  await expect(page.getByText("0 new source rows")).toBeVisible();
  await expect(page.getByText("501 already present")).toBeVisible();
});

test("unfamiliar statement CSV requires reviewed column and sign mapping", async ({
  page,
}) => {
  const source = `fixture-${Date.now()}`;
  await gotoAuthenticatedPage(page, "/statement-rows/import");
  await page.getByLabel("Statement CSV file").setInputFiles({
    name: `${source}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      "When,Details,Total,Flow\n2026-09-21,SYNTHETIC ORDER,29.99,out\n2026-09-22,SYNTHETIC REFUND,5.00,in",
    ),
  });
  const mapping = page.getByRole("region", { name: "Map statement columns" });
  await expect(mapping).toBeVisible();
  await mapping.getByLabel("Source name").fill(source);
  await mapping
    .getByLabel("Account name (for a single-account file)")
    .fill("Fixture checking (...4242)");
  await mapping.getByLabel("Date column").selectOption("When");
  await mapping.getByLabel("Description column").selectOption("Details");
  await mapping.getByLabel("Direction column").selectOption("Flow");
  await mapping
    .getByLabel("Amount convention")
    .selectOption("direction-column");
  await mapping.getByLabel("Charge value").fill("out");
  await mapping.getByLabel("Credit value").fill("in");
  await mapping.getByRole("button", { name: "Preview mapped rows" }).click();
  await expect(
    page.getByRole("heading", { name: new RegExp(`2 source rows.*${source}`) }),
  ).toBeVisible();
  await expect(page.getByText("$29.99")).toBeVisible();
  await page.getByRole("button", { name: "Save 2 source rows" }).click();
  await expect(page.getByText("2 new source rows")).toBeVisible();
});

test("identical purchases stay distinct and a changed provider date attaches reviewed evidence", async ({
  page,
}) => {
  const unique = `synthetic-${Date.now()}`;
  const account = `Occurrence Visa ${unique}`;
  await gotoAuthenticatedPage(page, "/statement-rows/import");
  await createEntityFixture(page, "financialAccount", {
    name: account,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    sourceAliases: [
      { source: "monarch", alias: account, externalAccountId: null },
    ],
  });
  const header =
    "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id";
  const descriptor = `SYNTHETIC CAFE ${unique}`;
  const upload = async (text: string) => {
    await page.getByLabel("Statement CSV file").setInputFiles({
      name: "occurrence.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(text),
    });
    await expect(
      page.getByRole("region", { name: "Statement preview" }),
    ).toBeVisible();
  };
  const file = `${header}\n2026-08-16,Synthetic Cafe,Food,${account},${descriptor},,-4.50,${unique}-one\n2026-08-16,Synthetic Cafe,Food,${account},${descriptor},,-4.50,${unique}-two`;
  await upload(file);
  const selection = page.getByRole("checkbox", {
    name: `Record ${descriptor}`,
    exact: true,
  });
  await expect(selection).toHaveCount(2);
  await selection.nth(0).check();
  await selection.nth(1).check();
  const kinds = page.getByLabel(`Transaction kind for ${descriptor}`, {
    exact: true,
  });
  await kinds.nth(0).selectOption("purchase");
  await kinds.nth(1).selectOption("purchase");
  await page
    .getByRole("button", {
      name: "Save rows and create 2 reviewed transactions",
    })
    .click();
  await expect(page.getByText(/2 transactions created/)).toBeVisible();
  await upload(
    `${header}\n2026-08-18,Synthetic Cafe,Food,${account},${descriptor},,-4.50,${unique}-one`,
  );
  const attach = page.getByLabel(
    `Attach existing transaction for ${descriptor}`,
    { exact: true },
  );
  await expect(attach).toBeVisible();
  const candidate = await attach.locator("option").nth(1).getAttribute("value");
  if (!candidate) throw new Error("Expected reviewed candidate");
  await attach.selectOption(candidate);
  await page
    .getByRole("button", {
      name: "Save rows and attach 1 reviewed observations",
    })
    .click();
  await expect(
    page.getByText(/0 transactions created.*1 observations attached/),
  ).toBeVisible();
});

test("CSV review blocks a provider duplicate outside the first preview page", async ({
  page,
}) => {
  const tag = `synthetic-paged-${Date.now()}`;
  await gotoAuthenticatedPage(page, "/statement-rows/import");
  await createEntityFixture(page, "financialAccount", {
    name: tag,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    sourceAliases: [{ source: "monarch", alias: tag, externalAccountId: null }],
  });
  const csv = [
    "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id",
    ...Array.from(
      { length: 201 },
      (_, index) =>
        `2026-08-25,Synthetic Page Store,Shopping,${tag},${tag}-${index},,-9.00,${index === 0 || index === 200 ? `${tag}-duplicate` : `${tag}-${index}`}`,
    ),
  ].join("\n");
  await page.getByLabel("Statement CSV file").setInputFiles({
    name: "synthetic-paged.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await expect(
    page.getByRole("checkbox", { name: `Record ${tag}-0`, exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("checkbox", { name: `Record ${tag}-1`, exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Save 201 source rows", exact: true })
    .click();
  await expect(page.getByText("201 new source rows")).toBeVisible();
  await expect(page.getByText(/0 transactions created/)).toBeVisible();
});
