import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { seedImagePrerequisite } from "./fixtures/photos";
import { attachExistingImageToEntity } from "~/server/domains/image/repo/image";
import { fieldSuggestionsReply } from "./support/field-suggestion-wire";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { entityApi } from "./support/entity-api";
import superjson from "superjson";
import { dispatchesOperation, unbatchFor } from "./support/dispatch-wire";
import {
  expectViewportBounded,
  gotoAuthenticatedPage,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import {
  createEntityFixture,
  createEvidenceHarnessContext,
} from "./fixtures/core";

// Real HTTP, editor and reference rendering verify reviewed identity persistence.
const categoryEmoji = entityFieldEnvelopeSchemas.productCategory.detail
  .pick({})
  .extend({
    fields: entityFieldEnvelopeSchemas.productCategory.detail.shape.fields.pick(
      { emoji: true },
    ),
  });

test("accepts a suggestion, saves compound emoji, and clears it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { id: root } = await createEntityFixture(page, "productCategory", {
    name: "Synthetic emoji food",
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
    fieldValueOf(
      categoryEmoji.parse(await beforeAcceptance.json()).fields.emoji,
    ),
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
    categoryEmoji.parse(
      await (
        await entityApi(page.request).get("productCategory", root, {})
      ).json(),
    );
  await expect
    .poll(async () => fieldValueOf((await read()).fields.emoji))
    .toBe("👩🏽‍🍳");
  await page
    .getByRole("button", { name: "Edit Product Category", exact: true })
    .click();
  await dialog.getByRole("textbox", { name: "Emoji", exact: true }).fill("");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => fieldValueOf((await read()).fields.emoji))
    .toBeNull();
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
