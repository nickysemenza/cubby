import { seedProductPrerequisite } from "./fixtures/catalog";
import { taxonomyShortcode } from "../../tooling/product-category-fixtures";
import {
  seedProductCategoryPrerequisite,
  seedWardrobePrerequisites,
} from "./fixtures/catalog";
import { createEntityFixture } from "./fixtures/core";
import { gotoAuthenticatedPage, openFoldedFacts } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Wardrobe is the generic Inventory list narrowed to an owner and the apparel
// category family; the same list answers for any member.
const wardrobeUrl = (owner: string) =>
  `/inventory?owner=${owner}&categoryFeature=apparel&view=shelf`;

test("wardrobe lists only the owner's entries and follows explicit ownership edits", async ({
  page,
}) => {
  const name = `Wardrobe ${Date.now()}`;
  const { owner, entry, location } = await seedWardrobePrerequisites(
    page,
    name,
  );
  await gotoAuthenticatedPage(
    page,
    `/locations/${location.id}#inventory`,
    page.locator("#inventory"),
  );
  await page.locator("#inventory").scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("columnheader", { name: /Reorder Owner column/ }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: `${name} shirt` })
      .getByText(`${name} owner`, { exact: true }),
  ).toBeVisible();
  const ownCard = page.getByRole("link", {
    name: `${name} shirt · ${name} drawer`,
    exact: true,
  });
  await gotoAuthenticatedPage(page, wardrobeUrl(owner.id), ownCard);
  await expect(
    page.getByRole("link", {
      name: `${name} shirt · ${name} other drawer`,
      exact: true,
    }),
  ).toHaveCount(0);

  await gotoAuthenticatedPage(
    page,
    `/inventory/${entry.id}`,
    page.getByRole("button", { name: "How owner is determined", exact: true }),
  );
  await page
    .getByRole("button", { name: "How owner is determined", exact: true })
    .click();
  // Reset saves inheritance intent immediately; the published ownership result
  // can remain missing until the bulk pass. Household is an explicit decision.
  await page
    .getByRole("button", { name: "Let Cubby decide", exact: true })
    .click();
  // With no stored owner the row folds under the not-recorded list.
  await openFoldedFacts(page, "Owner");
  await page
    .getByRole("button", { name: "How owner is determined", exact: true })
    .click();
  await expect(
    page.getByText("Following inherited values", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Set to Household", exact: true })
    .click();
  await expect(
    page.getByText("Household", { exact: true }).first(),
  ).toBeVisible();

  await gotoAuthenticatedPage(
    page,
    wardrobeUrl(owner.id),
    page.getByRole("heading", { name: "Inventory", exact: true }),
  );
  await expect(ownCard).toHaveCount(0);
});

test("wardrobe cards group at a category level and a header filters to that type with its sub-types", async ({
  page,
}) => {
  const name = `Wardrobe levels ${Date.now()}`;
  const { owner, location } = await seedWardrobePrerequisites(page, name);
  const tops = await seedProductCategoryPrerequisite(page, {
    name: `${name} Tops`,
    parentId: taxonomyShortcode("apparel"),
  });
  const tees = await seedProductCategoryPrerequisite(page, {
    name: `${name} Tees`,
    parentId: tops.id,
  });
  for (const [item, categoryId] of [
    ["Tops item", tops.id],
    ["Tee item", tees.id],
  ] as const) {
    const product = await seedProductPrerequisite(page, {
      name: `${name} ${item}`,
      brandName: "Fixture",
      categoryId,
    });
    await createEntityFixture(page, "inventory", {
      productId: product.id,
      locationId: location.id,
      amount: { value: 1, unit: "each" },
      ownershipMode: "explicit",
      ownerLedgerPartyId: owner.id,
    });
  }
  const sections = page.getByTestId("entity-card-grid").getByRole("region");
  const topsSection = sections.filter({ hasText: `${name} Tops` });
  await gotoAuthenticatedPage(
    page,
    `${wardrobeUrl(owner.id)}&groupBy=${encodeURIComponent(JSON.stringify([{ key: "category", level: 2 }]))}`,
    topsSection,
  );
  // The tee groups under its level-2 ancestor; the seed shirt sits in the
  // Apparel root, above that level, so it groups under itself.
  await expect(sections).toHaveText([
    /^Apparel/,
    new RegExp(`^${name} Tops\\s*2`),
  ]);
  await topsSection.hover();
  await topsSection.getByRole("button", { name: /Filter to this/ }).click();
  await expect(sections).toHaveText([new RegExp(`^${name} Tops\\s*2`)]);
  await expect(
    topsSection.getByRole("link", { name: new RegExp(`^${name} Tee item`) }),
  ).toBeVisible();
  const url = new URL(page.url());
  expect(JSON.parse(url.searchParams.get("groupBy") ?? "null")).toEqual([
    { key: "category", level: 2 },
  ]);
});
