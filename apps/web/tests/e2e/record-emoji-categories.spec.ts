import { z } from "zod";
import superjson from "superjson";
import { fieldSuggestionsOut } from "@cubby/schemas/ai";
import { dispatchesOperation, unbatchFor } from "./dispatch-wire";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Real HTTP, editor and reference rendering verify reviewed identity persistence.
test("edits compound emoji, clears it, and browses inherited category membership", async ({
  page,
  baseURL,
}, testInfo) => {
  const headers = { Origin: baseURL! };
  const create = async (
    path: string,
    data: z.infer<ReturnType<typeof z.json>>,
  ) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      headers,
      data,
    });
    expect(response.status(), await response.text()).toBe(201);
    return z
      .object({ item: z.object({ id: z.string() }) })
      .parse(await response.json()).item.id;
  };
  const patch = async (
    path: string,
    data: z.infer<ReturnType<typeof z.json>>,
  ) => {
    const response = await page.request.patch(`/api/v1/${path}`, {
      headers,
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const spending = await create("spending-categories", {
    name: "Synthetic emoji groceries",
    emoji: "🥕",
  });
  const root = await create("product-categories", {
    name: "Synthetic emoji food",
    spendingCategoryMode: "mapped",
    spendingCategoryId: spending,
  });
  for (const name of ["vegetables", "fruit", "bread"])
    await create("product-categories", {
      name: `Synthetic emoji ${name}`,
      parentId: root,
    });
  await create("product-categories", {
    name: "Synthetic emoji blocked",
    parentId: root,
    spendingCategoryMode: "blocked",
  });
  const vendor = await create("vendors", {
    name: "Synthetic emoji supplier",
    defaultSpendingCategoryId: spending,
  });
  await page.route("**/api/browser/dispatch", async (route) => {
    if (await unbatchFor(route, ["ai.suggestFields"])) return;
    if (!dispatchesOperation(route.request(), "ai.suggestFields"))
      return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        superjson.serialize({
          ok: true,
          data: fieldSuggestionsOut.parse({
            suggestions: {
              emoji: {
                value: "🥕",
                label: "🥕",
                detail: null,
                confidence: "high",
                probability: 0.99,
                reasoning: "Synthetic food category",
                alternatives: [],
              },
            },
          }),
        }),
      ),
    });
  });
  await gotoAuthenticatedPage(page, `/vendors/${vendor}`);
  await expect(
    page.getByRole("link", { name: /Synthetic emoji groceries/ }).first(),
  ).toBeVisible();
  await gotoAuthenticatedPage(page, `/product-categories/${root}`);
  await page
    .getByRole("button", { name: "Edit Product Category", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit Product Category" });
  await dialog
    .getByRole("button", { name: "Suggest emoji", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Emoji", exact: true }),
  ).toHaveValue("");
  const beforeAcceptance = await page.request.get(
    `/api/v1/product-categories/${root}`,
  );
  expect(
    z.object({ emoji: z.null() }).parse(await beforeAcceptance.json()).emoji,
  ).toBeNull();
  await dialog
    .getByRole("button", { name: "Use suggestion", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Emoji", exact: true }),
  ).toHaveValue("🥕");
  await dialog.getByRole("textbox", { name: "Emoji", exact: true }).fill("👩🏽‍🍳");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  const read = async () =>
    z
      .object({ emoji: z.string().nullable() })
      .parse(
        await (
          await page.request.get(`/api/v1/product-categories/${root}`)
        ).json(),
      );
  await expect.poll(async () => (await read()).emoji).toBe("👩🏽‍🍳");
  await page
    .getByRole("button", { name: "Edit Product Category", exact: true })
    .click();
  await dialog.getByRole("textbox", { name: "Emoji", exact: true }).fill("");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await read()).emoji).toBeNull();
  const project = await create("projects", {
    name: "Synthetic emoji project",
    kind: "household",
    year: 2199,
    emoji: "🛠️",
  });
  for (const emoji of [null, "🏠", null, "🛠️"]) {
    await patch(`projects/${project}`, { emoji });
    const body = await (
      await page.request.get(`/api/v1/projects/${project}`)
    ).json();
    expect(z.object({ emoji: z.string().nullable() }).parse(body).emoji).toBe(
      emoji,
    );
    expect(Object.hasOwn(body, "icon")).toBe(false);
  }
  const invalid = await page.request.patch(`/api/v1/projects/${project}`, {
    headers,
    data: { emoji: "multiple emoji 🥕🥦" },
  });
  expect(invalid.ok()).toBe(false);
  await gotoAuthenticatedPage(page, `/spending-categories/${spending}`);
  await page.getByRole("button", { name: /more/ }).first().click();
  await expect(
    page.getByRole("link", { name: /Synthetic emoji food.*vegetables/ }),
  ).toBeVisible();
  await expect(page.getByText(/Synthetic emoji blocked/)).toHaveCount(0);
  await page.getByRole("link", { name: "View all", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`spendingCategory=${spending}`));
  await page.setViewportSize({ width: 390, height: 844 });
  await expectViewportBounded(page);
  await page.screenshot({
    path: testInfo.outputPath("emoji-categories-phone.png"),
  });
});

test("reviews vendor purchase evidence and rejects stale accepted defaults", async ({
  page,
  baseURL,
  e2eRuntime,
}) => {
  test.setTimeout(90_000);
  const { Pool } = await import("pg");
  const { buildScenarioDatabase } =
    await import("../../tooling/scenarios/context");
  const { loadVendorSuggestionContext } =
    await import("~/server/repo/vendor-suggestion-context");
  const pool = new Pool({ connectionString: e2eRuntime.databaseUrl });
  const db = buildScenarioDatabase(pool);
  const headers = { Origin: baseURL! };
  const create = async (
    path: string,
    data: z.infer<ReturnType<typeof z.json>>,
  ) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      headers,
      data,
    });
    expect(response.status(), await response.text()).toBe(201);
    return z
      .object({ item: z.object({ id: z.string() }) })
      .parse(await response.json()).item.id;
  };
  try {
    const groceries = await create("spending-categories", {
      name: "Synthetic evidence groceries",
    });
    const tools = await create("spending-categories", {
      name: "Synthetic evidence tools",
    });
    const foodCategory = await create("product-categories", {
      name: "Synthetic evidence food",
      spendingCategoryMode: "mapped",
      spendingCategoryId: groceries,
    });
    const toolCategory = await create("product-categories", {
      name: "Synthetic evidence hardware",
      spendingCategoryMode: "mapped",
      spendingCategoryId: tools,
    });
    const food = await create("products", {
      name: "Synthetic evidence carrots",
      categoryId: foodCategory,
    });
    const tool = await create("products", {
      name: "Synthetic evidence wrench",
      categoryId: toolCategory,
    });
    const foodVendor = await create("vendors", {
      name: "Synthetic evidence market",
    });
    const mixed = await create("vendors", {
      name: "Synthetic evidence mixed shop",
    });
    const sparse = await create("vendors", {
      name: "Synthetic evidence sparse shop",
    });
    const misleading = await create("vendors", {
      name: "Synthetic evidence unknown shop",
      defaultSpendingCategoryId: groceries,
      spendingProfile: "food_retail",
    });
    const line = async (vendorId: string, productId?: string) => {
      const purchaseId = await create("purchases", {
        vendorId,
        date: "2026-09-01",
      });
      const data: z.infer<ReturnType<typeof z.json>> = {
        name: "Synthetic evidence purchase line",
        cost: 12,
        date: "2026-09-01",
        costType: "materials",
        trade: "other",
        purchaseId,
      };
      if (productId) data.productId = productId;
      await create("expenses", data);
    };
    await line(foodVendor, food);
    await line(foodVendor, food);
    await line(mixed, food);
    await line(mixed, tool);
    await line(misleading);
    const foodEvidence = await loadVendorSuggestionContext(db, foodVendor);
    expect(foodEvidence.groups).toHaveLength(1);
    expect(foodEvidence.lines).toHaveLength(2);
    expect((await loadVendorSuggestionContext(db, mixed)).groups).toHaveLength(
      2,
    );
    expect((await loadVendorSuggestionContext(db, sparse)).lines).toHaveLength(
      0,
    );
    expect(
      (await loadVendorSuggestionContext(db, misleading)).lines[0],
    ).toMatchObject({ explicitSpendingCategory: null, productCategory: null });
    await gotoAuthenticatedPage(page, `/vendors/${foodVendor}`);
    await expect(
      page.getByRole("link", { name: /Synthetic evidence food/ }).first(),
    ).toBeVisible();
    const accepted = {
      entity: "vendor",
      entityId: foodVendor,
      fingerprint: foodEvidence.fingerprint,
      defaultSpendingCategoryId: groceries,
      spendingProfile: "food_retail",
    };
    const changed = await page.request.patch(`/api/v1/vendors/${foodVendor}`, {
      headers,
      data: { notes: "Synthetic evidence changed after review" },
    });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const stale = await page.request.post(
      "/api/v1/ai/applyFinanceCategorySuggestion",
      { headers, data: accepted },
    );
    expect(stale.ok()).toBe(false);
    const fresh = await loadVendorSuggestionContext(db, foodVendor);
    const applied = await page.request.post(
      "/api/v1/ai/applyFinanceCategorySuggestion",
      { headers, data: { ...accepted, fingerprint: fresh.fingerprint } },
    );
    expect(applied.ok(), await applied.text()).toBeTruthy();
    const saved = await page.request.get(`/api/v1/vendors/${foodVendor}`);
    expect(
      z
        .object({
          defaultSpendingCategoryId: z.string(),
          spendingProfile: z.string(),
        })
        .parse(await saved.json()),
    ).toEqual({
      defaultSpendingCategoryId: groceries,
      spendingProfile: "food_retail",
    });
  } finally {
    await pool.end();
  }
});
