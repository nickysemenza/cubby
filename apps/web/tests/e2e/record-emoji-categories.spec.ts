import { seedImagePrerequisite } from "./fixtures/photos";
import { attachExistingImageToEntity } from "~/server/domains/image/repo/image";
import { fieldSuggestionsReply } from "./support/field-suggestion-wire";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { entityApi } from "./support/entity-api";
import { z } from "zod";
import superjson from "superjson";
import { dispatchesOperation, unbatchFor } from "./support/dispatch-wire";
import {
  expectViewportBounded,
  gotoAuthenticatedPage,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import {
  createEntityFixture,
  createFixtureGraph,
  createEvidenceHarnessContext,
} from "./fixtures/core";

// Real HTTP, editor and reference rendering verify reviewed identity persistence.
test("edits compound emoji, clears it, and browses inherited category membership", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { spending, root } = await createFixtureGraph(page, async (create) => {
    const spending = await create("spendingCategory", {
      name: "Synthetic emoji groceries",
      emoji: "🥕",
    });
    const root = await create("productCategory", {
      name: "Synthetic emoji food",
      spendingCategoryMode: "mapped",
      spendingCategoryId: spending.id,
    });
    for (const name of ["vegetables", "fruit", "bread"]) {
      await create("productCategory", {
        name: `Synthetic emoji ${name}`,
        parentId: root.id,
      });
    }
    await create("productCategory", {
      name: "Synthetic emoji blocked",
      parentId: root.id,
      spendingCategoryMode: "blocked",
    });
    return { spending: spending.id, root: root.id };
  });
  await gotoAuthenticatedPage(page, `/product-categories/${root}`);
  const { db } = await createEvidenceHarnessContext(page);
  const categoryId = await resolveOrThrow(db, "productCategory", root);
  const prediction = await publishAssessment(
    db,
    {
      publicationKey: `synthetic:category-emoji:${categoryId}`,
      family: "field",
      subject: {
        kind: "field",
        entity: "productCategory",
        recordId: categoryId,
        field: "emoji",
      },
      judgment: { value: "🥕", operation: "set", removals: [] },
      fingerprint: null,
      producer: null,
      evidence: null,
    },
    { active: false },
  );
  await page.route("**/api/operations/*", async (route) => {
    if (await unbatchFor(route, ["ai.suggestFields", "ai.suggestFieldsBatch"]))
      return;
    if (
      !dispatchesOperation(route.request(), "ai.suggestFields") &&
      !dispatchesOperation(route.request(), "ai.suggestFieldsBatch")
    )
      return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        superjson.serialize({
          ok: true,
          data: fieldSuggestionsReply(route.request(), {
            suggestions: {
              emoji: {
                assessmentId: prediction.id,
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
  await page
    .getByRole("button", { name: "Edit Product Category", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit Product Category" });
  await expect(
    dialog.getByRole("textbox", { name: "Emoji", exact: true }),
  ).toHaveValue("");
  const beforeAcceptance = await entityApi(page.request).get(
    "productCategory",
    root,
    {},
  );
  expect(
    z.object({ emoji: z.null() }).parse(await beforeAcceptance.json()).emoji,
  ).toBeNull();
  await dialog.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Emoji", exact: true }),
  ).toHaveValue("🥕");
  await page.unroute("**/api/operations/*");
  await dialog.getByRole("textbox", { name: "Emoji", exact: true }).fill("👩🏽‍🍳");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  const read = async () =>
    z
      .object({ emoji: z.string().nullable() })
      .parse(
        await (
          await entityApi(page.request).get("productCategory", root, {})
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
});

test("unassessed quality remains visible in phone cards", async ({
  page,
  e2eRuntime,
}) => {
  await page.setViewportSize({ width: 402, height: 874 });
  const name = `Synthetic planned quality ${Date.now()}`;
  await createEntityFixture(page, "expense", {
    name: `Synthetic unrelated quality ${Date.now()}`,
    future: false,
    cost: 12,
    date: "2026-01-01",
    costType: "services",
    trade: "other",
  });
  const { db, actor } = await createEvidenceHarnessContext(page);
  const vendor = await createEntityFixture(page, "vendor", {
    name: "Synthetic planned vendor",
  });
  const purchase = await createEntityFixture(page, "purchase", {
    vendorId: vendor.id,
    date: "2026-01-01",
  });
  const image = await seedImagePrerequisite(
    "planned-quality-cover",
    e2eRuntime.objectStorageUrl,
  );
  // Borrowed receipt media does not enable the Product identity check.
  await attachExistingImageToEntity(
    db,
    { imageId: image.id, targetId: purchase.id },
    actor,
  );
  await createEntityFixture(page, "expense", {
    name,
    purchaseId: purchase.id,
    future: true,
    cost: null,
    date: null,
    costType: "services",
    trade: "other",
  });
  await gotoAuthenticatedPage(
    page,
    `/expenses?q=${encodeURIComponent(name)}&pageSize=1`,
  );
  await expect(
    page.getByRole("button", { name: `Expense ${name}`, exact: true }),
  ).toBeVisible();
  const card = page.getByRole("listitem").filter({ hasText: name });
  await expect(card).toContainText("Not assessed");
  await card
    .getByRole("button", { name: /How (data )?quality is determined/ })
    .click();
  const popover = page.locator('[data-slot="popover-content"]');
  await popover
    .getByRole("button", { name: "Technical details", exact: true })
    .click();
  await expect(popover).toContainText("No weighted checks apply");
  await expectViewportBounded(page);
});
