import { entityRecordsOutputSchema } from "~/contracts/entity-records.schema";
import { fieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { superJsonResultSchema } from "~/lib/superjson-wire";
import superjson from "superjson";
import { z } from "zod";
import {
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
  expectViewportBounded,
} from "./e2e-helpers";
import {
  seedProductPrerequisite,
  seedPlantPrerequisite,
  seedLocationPrerequisite,
  seedTaskPrerequisite,
} from "./fixtures-catalog";
import { createEntityFixture } from "./fixtures-core";
import { expect, test } from "./e2e-test";
import {
  dispatchesOperation,
  dispatchOperations,
  unbatchFor,
} from "./dispatch-wire";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("quality leads entity tables, explains its calculation, and restores temporary ordering", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const name = `Synthetic quality ${Date.now()}`;
  const plant = await seedPlantPrerequisite(page, `${name} crop`);
  const product = await seedProductPrerequisite(page, {
    name,
    manufacturer: "Synthetic",
    growsPlantId: plant.id,
  });
  const location = await seedLocationPrerequisite(page, `${name} shelf`);
  await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 1, unit: "each" },
  });
  const lowerScoreName = `${name} missing`;
  const lowerScoreProduct = await seedProductPrerequisite(page, {
    name: lowerScoreName,
    manufacturer: "(unspecified)",
    growsPlantId: plant.id,
  });
  await createEntityFixture(page, "inventory", {
    productId: lowerScoreProduct.id,
    locationId: location.id,
    amount: { value: 1, unit: "each" },
  });
  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(name)}&view=table`,
  );
  const table = page.getByRole("table").first();
  const headers = table.getByRole("columnheader");
  const labels = await headers.allTextContents();
  expect(labels.findIndex((text) => text.includes("Quality"))).toBe(
    labels.findIndex((text) => text.includes("Product")) + 1,
  );
  const row = table.getByRole("row").filter({ hasText: name }).first();
  await expect(row).toContainText("/100");
  await row
    .getByRole("button", { name: /How (data )?quality is determined/ })
    .click();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(
    popover.getByRole("heading", { name: "Score calculation" }),
  ).toBeVisible();
  await expect(
    popover.getByRole("heading", { name: "Technical details" }),
  ).toBeVisible();
  const technicalDisclosure = popover
    .locator("details")
    .filter({
      has: page.getByRole("heading", { name: "Technical details" }),
    })
    .first();
  await expect(technicalDisclosure).not.toHaveAttribute("open");
  await expect(
    popover.locator("summary").filter({ hasText: /satisfied checks/ }),
  ).toBeVisible();
  await expect(popover).toContainText("applicable weight");
  await expect(popover).toContainText(
    "Only this record's applicable weighted checks",
  );
  await expect(popover).toContainText("product.data-quality");
  const calculation = popover.getByRole("heading", {
    name: "Score calculation",
  });
  const technical = popover.getByRole("heading", { name: "Technical details" });
  expect((await calculation.boundingBox())!.y).toBeLessThan(
    (await technical.boundingBox())!.y,
  );
  await expect(popover.locator("pre")).toHaveCount(0);
  const footer = popover.locator("footer");
  await expect(footer).toBeVisible();
  // Read both bounds in one browser turn while the popover can reposition.
  const footerOverflow = await popover.evaluate((element) => {
    const footerElement = element.querySelector("footer");
    if (!footerElement) throw new Error("Explanation footer is missing");
    return (
      footerElement.getBoundingClientRect().bottom -
      element.getBoundingClientRect().bottom
    );
  });
  expect(footerOverflow).toBeLessThanOrEqual(0);
  await expectViewportBounded(page);
  await page.screenshot({ path: testInfo.outputPath("quality-desktop.png") });
  await page.keyboard.press("Escape");
  await expect(popover).not.toBeVisible();

  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Columns…", exact: true }).click();
  await page
    .getByRole("button", { name: "Move Quality later", exact: true })
    .click();
  await page.keyboard.press("Escape");
  const changed = await headers.allTextContents();
  expect(changed).not.toEqual(labels);
  await reloadAuthenticatedPage(page, table);
  await expect.poll(() => headers.allTextContents()).toEqual(labels);
  await table.getByRole("columnheader", { name: /Quality/ }).click();
  await expect(page).toHaveURL(/sort=.*dataQuality/);
  await expect(table.locator("tbody tr").first()).toContainText(lowerScoreName);

  await gotoAuthenticatedPage(page, `/plants/${plant.id}`);
  const related = page.locator("#products");
  await expect(related.getByText("Quality", { exact: true })).toBeVisible();
  await expect(
    related.getByRole("row").filter({ hasText: name }).first(),
  ).toContainText("/100");

  const categoryName = `${name} category`;
  await createEntityFixture(page, "spendingCategory", { name: categoryName });
  await gotoAuthenticatedPage(
    page,
    `/spending-categories?view=table&name=${encodeURIComponent(categoryName)}`,
  );
  const categoryRow = page
    .getByRole("row")
    .filter({ hasText: categoryName })
    .first();
  await expect(
    categoryRow.locator('[data-cell-col="dataQuality"] [data-cell-value]'),
  ).toHaveText("0/100");

  const plannedName = `${name} planned`;
  await createEntityFixture(page, "expense", {
    name: plannedName,
    costType: "services",
    trade: "other",
    future: true,
    cost: null,
    date: null,
  });
  await gotoAuthenticatedPage(
    page,
    `/expenses?view=table&q=${encodeURIComponent(plannedName)}`,
  );
  const unassessedRow = page
    .getByRole("row")
    .filter({ hasText: plannedName })
    .first();
  await expect(
    unassessedRow.locator('[data-cell-col="dataQuality"] [data-cell-value]'),
  ).toHaveText("Not assessed");
  await page.getByRole("columnheader", { name: /Quality/ }).click();
  await expect(page).toHaveURL(/sort=.*dataQuality/);
  await unassessedRow
    .getByRole("button", { name: /How (data )?quality is determined/ })
    .click();
  await expect(popover).toContainText("Not assessed");
  await expect(popover).toContainText("No weighted checks apply");
  await page.keyboard.press("Escape");
});

test("quality explanations reconcile exceptions, defects, and related gaps", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const name = `Synthetic quality states ${Date.now()}`;
  const product = await seedProductPrerequisite(page, {
    name,
    manufacturer: "(unspecified)",
  });
  const dispatch = async (operation: string, input: unknown) => {
    const response = await page.request.post("/api/browser/dispatch", {
      headers: { Origin: baseURL! },
      data: superjson.serialize({ operation, input: z.json().parse(input) }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const result = superjson.deserialize(
      superJsonResultSchema.parse(await response.json()),
    );
    return z.object({ ok: z.literal(true), data: z.unknown() }).parse(result)
      .data;
  };
  const explain = async (entityKind: string, entityId: string) =>
    fieldExplanationOutput.parse(
      await dispatch("fieldExplanation.explain", {
        entityKind,
        entityId,
        field: "dataQuality",
        surface: "list",
      }),
    );
  const unstocked = await explain("product", product.id);
  expect(unstocked.qualityBreakdown).toMatchObject({
    score: 30,
    expectedWeight: 10,
  });
  const location = await seedLocationPrerequisite(page, `${name} shelf`);
  await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 1, unit: "each" },
  });
  const before = await explain("product", product.id);
  expect(before.value).toBe(before.qualityBreakdown?.score);
  expect(before.interpretation?.result).toMatch(/^\d+\/100$/);
  expect(before.qualityBreakdown?.checks).toContainEqual(
    expect.objectContaining({ check: "product_manufacturer", state: "gap" }),
  );
  await dispatch("dataQuality.setException", {
    entityId: product.id,
    check: "product_manufacturer",
    reason: "not_applicable",
    note: "Synthetic unbranded product.",
  });
  const active = await explain("product", product.id);
  expect(active.qualityBreakdown?.checks).toContainEqual(
    expect.objectContaining({
      check: "product_manufacturer",
      state: "excepted",
    }),
  );
  expect(active.qualityBreakdown!.score).toBeGreaterThan(
    z.number().parse(before.qualityBreakdown!.score),
  );
  for (const check of active.qualityBreakdown!.checks.filter(
    (check) => check.state === "gap",
  )) {
    const reason = check.exceptionReasons[0]?.reason;
    expect(
      reason,
      `Synthetic gap ${check.check} must admit an evidence-bound exception`,
    ).toBeTruthy();
    await dispatch("dataQuality.setException", {
      entityId: product.id,
      check: check.check,
      reason,
      note: "Synthetic unavailable evidence.",
    });
  }
  const accepted = await explain("product", product.id);
  expect(accepted.qualityBreakdown).toMatchObject({
    score: 100,
    status: "complete_with_exceptions",
  });
  await gotoAuthenticatedPage(
    page,
    `/products?view=table&name=${encodeURIComponent(name)}`,
  );
  const acceptedRow = page.getByRole("row").filter({ hasText: name }).first();
  const acceptedCell = acceptedRow.locator(
    '[data-cell-col="dataQuality"] [data-cell-value]',
  );
  await expect(acceptedCell).toContainText("100/100");
  await expect(acceptedCell).toContainText("Complete with exceptions");
  await expect(acceptedCell.locator("svg")).toBeVisible();
  const updated = await page.request.patch(`/api/v1/products/${product.id}`, {
    headers: { Origin: baseURL! },
    data: { manufacturer: "(UNSPECIFIED)" },
  });
  expect(updated.ok(), await updated.text()).toBeTruthy();
  const stale = await explain("product", product.id);
  expect(stale.qualityBreakdown?.checks).toContainEqual(
    expect.objectContaining({ check: "product_manufacturer", state: "gap" }),
  );
  expect(stale.sources).toContainEqual(
    expect.objectContaining({
      label: "Exceptions",
      value: expect.arrayContaining([
        expect.objectContaining({ state: "stale" }),
      ]),
    }),
  );
  const vendor = await createEntityFixture(page, "vendor", {
    name: `${name} vendor`,
  });
  const purchase = await createEntityFixture(page, "purchase", {
    vendorId: vendor.id,
    date: "2026-09-10",
    statedTotal: 10,
    orderId: name,
  });
  await createEntityFixture(page, "expense", {
    name: `${name} item`,
    purchaseId: purchase.id,
    productId: product.id,
    cost: 2,
    date: "2026-09-10",
    costType: "materials",
    trade: "other",
  });
  const defect = await explain("purchase", purchase.id);
  expect(defect.value).toBe(defect.qualityBreakdown?.score);
  expect(defect.interpretation?.result).toMatch(/^\d+\/100$/);
  const records = entityRecordsOutputSchema.parse(
    await dispatch("entity.records", { kind: "purchase", q: name }),
  );
  expect(records.items).toContainEqual(
    expect.objectContaining({
      id: purchase.id,
      quality: defect.qualityBreakdown?.score,
      qualityStatus: "defect",
    }),
  );
  expect(defect.qualityBreakdown?.checks).toContainEqual(
    expect.objectContaining({
      check: "paperwork_mismatch",
      state: "gap",
      kind: "defect",
    }),
  );
  expect(
    defect.qualityBreakdown?.checks.some(
      (check) => check.check === "product_manufacturer",
    ),
  ).toBe(false);
  expect(defect.sources).toContainEqual(
    expect.objectContaining({
      label: "Related record gaps",
      value: expect.arrayContaining([
        expect.objectContaining({ check: "product_manufacturer" }),
      ]),
    }),
  );
  const breakdown = defect.qualityBreakdown!;
  expect(breakdown.weightedScore).toBe(
    Math.round((breakdown.satisfiedWeight / breakdown.expectedWeight) * 10000) /
      100,
  );
  expect(breakdown.score).toBe(
    Math.min(breakdown.weightedScore!, breakdown.scoreCap ?? 100),
  );
  expect(breakdown.score).toBeLessThanOrEqual(49);
  await gotoAuthenticatedPage(
    page,
    `/purchases?view=table&q=${encodeURIComponent(name)}`,
  );
  const row = page.getByRole("row").filter({ hasText: name }).first();
  await row
    .getByRole("button", { name: /How (data )?quality is determined/ })
    .click();
  await expect(page.locator('[data-slot="popover-content"]')).toContainText(
    "Paperwork mismatch",
  );
});

test("a person accepts a data gap as an exception from the explanation and clears it", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 402, height: 874 });
  const name = `Synthetic exception ${Date.now()}`;
  const product = await seedProductPrerequisite(page, {
    name,
    manufacturer: "(unspecified)",
  });
  const location = await seedLocationPrerequisite(page, `${name} shelf`);
  await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 1, unit: "each" },
  });
  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(name)}&view=table`,
  );
  const row = page.getByRole("listitem").filter({ hasText: name }).first();
  const trigger = row.getByRole("button", {
    name: /How (data )?quality is determined/,
  });
  const popover = page.locator('[data-slot="popover-content"]');
  const check = popover.locator('[data-quality-check="product_manufacturer"]');
  await expect(async () => {
    if (!(await popover.isVisible())) await trigger.click();
    await expect(check).toContainText("Missing data");
  }).toPass();
  await check.getByRole("button", { name: "Accept as…" }).click();
  await check.getByLabel("Reason").selectOption({ label: "Not applicable" });
  await check.getByLabel("Note").fill("Synthetic unbranded product.");
  await check.getByRole("button", { name: "Accept exception" }).click();
  await expect(check).toContainText("Accepted exception");
  await expect(
    check.getByRole("button", { name: "Clear exception" }),
  ).toBeVisible();
  await check.getByRole("button", { name: "Clear exception" }).click();
  await expect(check).toContainText("Missing data");
  await expect(check.getByRole("button", { name: "Accept as…" })).toBeVisible();
  await check.getByRole("button", { name: "Accept as…" }).click();
  await check.getByRole("button", { name: "Accept exception" }).click();
  await expect(check).toContainText("Accepted exception");
  const changed = await page.request.patch(`/api/v1/products/${product.id}`, {
    headers: { Origin: baseURL! },
    data: { manufacturer: "Synthetic recorded maker" },
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  await reloadAuthenticatedPage(page, row);
  await expect(async () => {
    if (!(await popover.isVisible())) await trigger.click();
    await expect(check).toContainText(
      "Evidence changed since this exception was recorded",
    );
  }).toPass();
  await expect(
    check.getByRole("button", { name: "Clear exception" }),
  ).toBeVisible();
  await check.getByRole("button", { name: "Clear exception" }).click();
  await expect(
    check.getByRole("button", { name: "Clear exception" }),
  ).toHaveCount(0);
});

test("explanations load lazily, recover from errors, and expand bounded evidence on phones", async ({
  page,
}, testInfo) => {
  const name = `Synthetic explanation recovery ${Date.now()}`;
  const product = await seedProductPrerequisite(page, { name });
  const requests: string[][] = [];
  page.on("request", (request) => {
    if (dispatchesOperation(request, "fieldExplanation.explain"))
      requests.push(dispatchOperations(request).map((item) => item.operation));
  });
  await page.setViewportSize({ width: 402, height: 874 });
  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(name)}&view=table`,
  );
  const row = page.getByRole("listitem").filter({ hasText: name }).first();
  const trigger = row.getByRole("button", {
    name: /How (data )?quality is determined/,
  });
  await expect(trigger).toBeVisible();
  expect(requests).toHaveLength(0);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/browser/dispatch", async (route) => {
    if (await unbatchFor(route, ["fieldExplanation.explain"])) return;
    if (!dispatchesOperation(route.request(), "fieldExplanation.explain"))
      return route.continue();
    await gate;
    await route.fulfill({
      status: 503,
      contentType: "text/plain",
      body: "Synthetic explanation temporarily unavailable",
    });
  });
  await trigger.click();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toContainText("Loading…");
  release();
  await expect(
    popover.getByRole("button", { name: "Retry explanation" }),
  ).toBeVisible();
  await page.unroute("**/api/browser/dispatch");
  await page.route("**/api/browser/dispatch", async (route) => {
    if (await unbatchFor(route, ["fieldExplanation.explain"])) return;
    if (!dispatchesOperation(route.request(), "fieldExplanation.explain"))
      return route.continue();
    const response = await route.fetch();
    const wire = superJsonResultSchema.parse(await response.json());
    const envelope = z
      .object({ ok: z.literal(true), data: fieldExplanationOutput })
      .parse(superjson.deserialize(wire));
    const data = fieldExplanationOutput.parse({
      ...envelope.data,
      truncated: true,
      sources: Array.from({ length: 25 }, (_, index) => {
        const value = {
          amount: -159.84,
          note: "Synthetic supporting evidence with a long readable description for viewport and scrolling verification.",
        };
        return {
          label: `Synthetic evidence ${index + 1}`,
          entity: null,
          value:
            index === 0
              ? {
                  ...value,
                  rawImportPreview: {
                    section: {
                      entries: {
                        record: {
                          source: {
                            description:
                              "Synthetic deeply nested evidence remains readable within the explanation panel.",
                          },
                        },
                      },
                    },
                  },
                }
              : value,
        };
      }),
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(superjson.serialize({ ok: true, data })),
    });
  });
  await popover.getByRole("button", { name: "Retry explanation" }).click();
  await expect(popover).toContainText("Score calculation");
  await expect(popover).toContainText("Technical details");
  await expect(
    popover.getByText("Synthetic evidence 7", { exact: true }),
  ).not.toBeVisible();
  await popover
    .getByText("Show 19 more evidence entries", { exact: true })
    .click();
  await expect(
    popover.getByText("Synthetic evidence 25", { exact: true }),
  ).toBeVisible();
  await expect(popover).toContainText("not an exhaustive list");
  await expect(popover).toContainText("-$159.84");
  await page.setViewportSize({ width: 402, height: 874 });
  await expectViewportBounded(page);
  expect(
    await popover.evaluate((panel) => panel.scrollWidth),
  ).toBeLessThanOrEqual(await popover.evaluate((panel) => panel.clientWidth));
  await expect
    .poll(async () => {
      const bounds = await popover.boundingBox();
      const viewport = page.viewportSize();
      return (
        bounds !== null &&
        viewport !== null &&
        bounds.y >= 0 &&
        bounds.y + bounds.height <= viewport.height
      );
    })
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("large-evidence-phone.png"),
  });
  await page.keyboard.press("Escape");
  await expect(popover).not.toBeVisible();
  await expect(trigger).toBeFocused();
  // A refused batch is a transport envelope, not another explanation attempt.
  // Count the failed single-operation request and the explicit Retry request.
  expect(requests.filter((operations) => operations.length === 1)).toHaveLength(
    2,
  );
  expect(product.id).toBeTruthy();
});

test("specialist board and gallery cards retain the shared quality explanation", async ({
  page,
}) => {
  const name = `Synthetic specialist quality ${Date.now()}`;
  const task = await seedTaskPrerequisite(page, { name });
  await gotoAuthenticatedPage(
    page,
    `/tasks?view=board&q=${encodeURIComponent(name)}`,
  );
  const card = page
    .locator(".group.relative")
    .filter({ has: page.getByRole("button", { name, exact: true }) });
  await expect(card).toContainText("/100");
  await card
    .getByRole("button", { name: /How (data )?quality is determined/ })
    .click();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toContainText("task.data-quality");
  await page.keyboard.press("Escape");
  const location = await seedLocationPrerequisite(page, `${name} shelf`);
  await gotoAuthenticatedPage(page, "/locations?view=gallery");
  const locationCard = page
    .locator(`[data-location-id="${location.id}"]`)
    .first();
  await expect(locationCard).toContainText("Not assessed");
  await locationCard
    .getByRole("button", { name: /How (data )?quality is determined/ })
    .click();
  await expect(popover).toContainText("location.data-quality");
  expect(task.id).toBeTruthy();
});

test("explanation evidence formats links and dates without exposing internal entity ids", async ({
  page,
}) => {
  const { getFixtureDb } = await import("./fixtures-core");
  const { getDb } = await import("~/server/repo/database-helpers");
  const { resolveProductIdentifierSource } =
    await import("~/server/repo/product-identifier-source");
  const { vendor } = await import("~/server/db/schema");
  const { eq } = await import("drizzle-orm");
  const suffix = Date.now();
  const vendorName = `Synthetic evidence supplier ${suffix}`;
  const url = `https://example.com/catalog/${"synthetic-".repeat(30)}item`;
  const supplier = await createEntityFixture(page, "vendor", {
    name: vendorName,
    website: "https://example.com",
  });
  const storedVendor = await getDb(getFixtureDb()).query.vendor.findFirst({
    where: eq(vendor.shortcode, supplier.id),
    columns: { id: true },
  });
  if (!storedVendor) throw new Error("Synthetic supplier fixture is missing");
  const source = await resolveProductIdentifierSource(getFixtureDb(), {
    vendorId: storedVendor.id,
    url,
  });
  const productName = `Synthetic formatted evidence ${suffix}`;
  const product = await seedProductPrerequisite(page, {
    name: productName,
    externalIds: [
      {
        source,
        kind: "retailer_sku",
        externalId: `SYNTHETIC-${suffix}`,
        url,
      },
    ],
  });
  await createEntityFixture(page, "expense", {
    name: `Synthetic dated line ${suffix}`,
    productId: product.id,
    productQuantity: 1,
    cost: 12,
    date: "2022-03-11",
    costType: "materials",
    trade: "other",
  });
  await gotoAuthenticatedPage(
    page,
    `/products?view=table&name=${encodeURIComponent(productName)}`,
  );
  const row = page.getByRole("row").filter({ hasText: productName });
  await expect(row.locator('[data-cell-col="purchaseDate"]')).toContainText(
    /Mar 11, 2022 \(.+ ago\)/,
  );
  await row
    .locator('[data-cell-col="primaryGtin"]')
    .getByRole("button", { name: /How primary gtin is determined/ })
    .click();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(
    popover.getByRole("link", { name: /example.com\/catalog\// }),
  ).toHaveAttribute("href", url);
  await expect(
    popover.getByRole("link", { name: vendorName, exact: true }),
  ).toHaveAttribute("href", `/vendors/${supplier.id}`);
  await expect(popover).not.toContainText(storedVendor.id);
  const times = popover.locator("time[datetime]:visible");
  await expect(times).toHaveCount(2);
  await expect(times.first()).not.toContainText(/T\d{2}:\d{2}/);
  await page.setViewportSize({ width: 402, height: 874 });
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  await page
    .getByRole("button", { name: /How external ids is determined/ })
    .click();
  await expect(
    popover.getByRole("link", { name: vendorName, exact: true }),
  ).toBeVisible();
  await expectViewportBounded(page);
  expect(
    await popover.evaluate((panel) => panel.scrollWidth),
  ).toBeLessThanOrEqual(await popover.evaluate((panel) => panel.clientWidth));
});
