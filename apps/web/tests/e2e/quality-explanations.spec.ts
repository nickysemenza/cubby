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
import { dispatchesOperation } from "./dispatch-wire";

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
  expect(labels.findIndex((text) => text.includes("Data quality"))).toBe(
    labels.findIndex((text) => text.includes("Product")) + 1,
  );
  const row = table.getByRole("row").filter({ hasText: name }).first();
  await expect(row).toContainText("/100");
  await row
    .getByRole("button", { name: "How data quality is determined" })
    .click();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(
    popover.getByRole("heading", { name: "What this means" }),
  ).toBeVisible();
  await expect(
    popover.getByRole("heading", { name: "Technical details" }),
  ).toBeVisible();
  await expect(popover).toContainText("applicable weight");
  await expect(popover).toContainText(
    "Only this record's applicable weighted checks",
  );
  await expect(popover).toContainText("product.data-quality");
  await expect(popover.locator("pre")).toHaveCount(0);
  await expectViewportBounded(page);
  await page.screenshot({ path: testInfo.outputPath("quality-desktop.png") });
  await page.keyboard.press("Escape");
  await expect(popover).not.toBeVisible();

  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Columns…", exact: true }).click();
  await page
    .getByRole("button", { name: "Move Data quality later", exact: true })
    .click();
  await page.keyboard.press("Escape");
  const changed = await headers.allTextContents();
  expect(changed).not.toEqual(labels);
  await reloadAuthenticatedPage(page, table);
  await expect.poll(() => headers.allTextContents()).toEqual(labels);
  await table.getByRole("columnheader", { name: /Data quality/ }).click();
  await expect(page).toHaveURL(/sort=.*dataQuality/);
  await expect(table.locator("tbody tr").first()).toContainText(lowerScoreName);

  await gotoAuthenticatedPage(page, `/plants/${plant.id}`);
  const related = page.locator("#products");
  await expect(
    related.getByText("Data quality", { exact: true }),
  ).toBeVisible();
  await expect(
    related.getByRole("row").filter({ hasText: name }).first(),
  ).toContainText("/100");

  const categoryName = `${name} category`;
  await createEntityFixture(page, "spendingCategory", { name: categoryName });
  await gotoAuthenticatedPage(
    page,
    `/spending-categories?view=table&name=${encodeURIComponent(categoryName)}`,
  );
  const unassessedRow = page
    .getByRole("row")
    .filter({ hasText: categoryName })
    .first();
  await expect(unassessedRow).toContainText("Not assessed");
  const unscoredURL = page.url();
  await page.getByRole("columnheader", { name: /Data quality/ }).click();
  await expect(page).toHaveURL(unscoredURL);
  await unassessedRow
    .getByRole("button", { name: "How data quality is determined" })
    .click();
  await expect(popover).toContainText("No quality checks are defined");
  await expect(popover).toContainText("not a score of zero");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 402, height: 874 });
  await page
    .getByRole("listitem")
    .filter({ hasText: categoryName })
    .getByRole("button", { name: "How data quality is determined" })
    .click();
  await expect(popover).toBeVisible();
  await expectViewportBounded(page);
  await page.screenshot({ path: testInfo.outputPath("quality-phone.png") });
  expect(product.id).toBeTruthy();
});

test("quality explanations reconcile exceptions, defects, and related gaps", async ({
  page,
  baseURL,
}) => {
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
    score: 100,
    expectedWeight: 0,
  });
  const location = await seedLocationPrerequisite(page, `${name} shelf`);
  await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 1, unit: "each" },
  });
  const before = await explain("product", product.id);
  expect(before.value).toBe("needs_data");
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
    before.qualityBreakdown!.score,
  );
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
  expect(defect.value).toBe("defect");
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
  expect(breakdown.score).toBe(
    Math.round((breakdown.satisfiedWeight / breakdown.expectedWeight) * 10000) /
      100,
  );
  await gotoAuthenticatedPage(
    page,
    `/purchases?view=table&search=${encodeURIComponent(name)}`,
  );
  const row = page.getByRole("row").filter({ hasText: name }).first();
  await row
    .getByRole("button", { name: "How data quality is determined" })
    .click();
  await expect(page.locator('[data-slot="popover-content"]')).toContainText(
    "Paperwork mismatch",
  );
});

test("explanations load lazily, recover from errors, and expand bounded evidence on phones", async ({
  page,
}, testInfo) => {
  const name = `Synthetic explanation recovery ${Date.now()}`;
  const product = await seedProductPrerequisite(page, { name });
  let requests = 0;
  page.on("request", (request) => {
    if (dispatchesOperation(request, "fieldExplanation.explain")) requests += 1;
  });
  await page.setViewportSize({ width: 402, height: 874 });
  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(name)}&view=table`,
  );
  const row = page.getByRole("listitem").filter({ hasText: name }).first();
  const trigger = row.getByRole("button", {
    name: "How data quality is determined",
  });
  await expect(trigger).toBeVisible();
  expect(requests).toBe(0);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/browser/dispatch", async (route) => {
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
      sources: Array.from({ length: 25 }, (_, index) => ({
        label: `Synthetic evidence ${index + 1}`,
        entity: null,
        value: {
          amount: -159.84,
          note: "Synthetic supporting evidence with a long readable description for viewport and scrolling verification.",
        },
      })),
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(superjson.serialize({ ok: true, data })),
    });
  });
  await popover.getByRole("button", { name: "Retry explanation" }).click();
  await expect(popover).toContainText("What this means");
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
  expect(requests).toBe(2);
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
    .getByRole("button", { name: "How data quality is determined" })
    .click();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toContainText("task.data-quality");
  await page.keyboard.press("Escape");
  const location = await seedLocationPrerequisite(page, `${name} shelf`);
  await gotoAuthenticatedPage(page, "/locations?view=gallery");
  const locationCard = page
    .locator(`[data-location-id="${location.id}"]`)
    .first();
  await expect(locationCard).toContainText("/100");
  await locationCard
    .getByRole("button", { name: "How data quality is determined" })
    .click();
  await expect(popover).toContainText("location.data-quality");
  expect(task.id).toBeTruthy();
});
