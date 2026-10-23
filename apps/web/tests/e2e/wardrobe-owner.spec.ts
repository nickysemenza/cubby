import { seedProductPrerequisite } from "./fixtures/catalog";
import { taxonomyShortcode } from "../../tooling/product-category-fixtures";
import {
  seedProductCategoryPrerequisite,
  seedWardrobePrerequisites,
} from "./fixtures/catalog";
import { createEntityFixture, seedConcurrently } from "./fixtures/core";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
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
    `/locations/${location.id}`,
    page.getByRole("columnheader", { name: /ownerLedgerPartyId column Owner/ }),
  );
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
    page.getByRole("button", { name: "Use inherited", exact: true }),
  );
  // The owner is the generic resolved field: set here, then inherited (no
  // purchase evidence names anyone, so Unknown), then Household.
  await page
    .getByRole("button", { name: "Use inherited", exact: true })
    .click();
  await expect(
    page.getByText("Unknown", { exact: true }).first(),
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

test("home pins open the viewer's wardrobe as a generic saved view", async ({
  page,
}) => {
  const wardrobe = page.getByRole("link", { name: /^Wardrobe(, \d+)?$/ });
  await gotoAuthenticatedPage(page, "/", wardrobe);
  const href = new URL(
    (await wardrobe.getAttribute("href")) ?? "",
    "http://localhost",
  );
  expect(href.pathname).toBe("/inventory");
  // `@me` travels as a token; the server resolves it per member.
  expect(href.searchParams.get("owner")).toBe("@me");
  expect(href.searchParams.get("categoryFeature")).toBe("apparel");
  expect(href.searchParams.get("view")).toBe("shelf");
  expect(JSON.parse(href.searchParams.get("groupBy") ?? "null")).toEqual([
    { key: "category", level: 2 },
  ]);
  // Apparel is the taxonomy root, so clothing types are its second level.
  expect(href.searchParams.has("groupLevel")).toBe(false);
});

test("wardrobe cards section by clothing type and a header filters to one type", async ({
  page,
}) => {
  const name = `Wardrobe groups ${Date.now()}`;
  const { owner, location } = await seedWardrobePrerequisites(page, name);
  for (const type of ["Tops", "Outerwear"]) {
    const category = await seedProductCategoryPrerequisite(page, {
      name: `${name} ${type}`,
      parentId: taxonomyShortcode("apparel"),
    });
    const product = await seedProductPrerequisite(page, {
      name: `${name} ${type} item`,
      brandName: "Fixture",
      categoryId: category.id,
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
  const tops = sections.filter({ hasText: `${name} Tops` });
  await gotoAuthenticatedPage(
    page,
    `${wardrobeUrl(owner.id)}&groupBy=${encodeURIComponent(JSON.stringify([{ key: "category" }]))}`,
    tops,
  );
  // Related-record sections follow their labels; the seed shirt sits in the
  // Apparel root itself.
  await expect(sections).toHaveText([
    /^Apparel/,
    new RegExp(`^${name} Outerwear`),
    new RegExp(`^${name} Tops`),
  ]);
  await tops.hover();
  await tops.getByRole("button", { name: /Filter to this/ }).click();
  await expect(sections).toHaveText([new RegExp(`^${name} Tops`)]);
  await expect(
    tops.getByRole("link", { name: new RegExp(`^${name} Tops item`) }),
  ).toBeVisible();
  expect(
    JSON.parse(new URL(page.url()).searchParams.get("groupBy") ?? "null"),
  ).toEqual([{ key: "category" }]);
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

// Without the apparel family scope, so an uncategorized owned item shows.
test("wardrobe cards exclude a clothing type, keep uncategorized items, and a header hides a section", async ({
  page,
}) => {
  const name = `Wardrobe except ${Date.now()}`;
  const { owner, location } = await seedWardrobePrerequisites(page, name);
  const own = {
    locationId: location.id,
    amount: { value: 1, unit: "each" },
    ownershipMode: "explicit",
    ownerLedgerPartyId: owner.id,
  } as const;
  for (const type of ["Tops", "Outerwear"]) {
    const category = await seedProductCategoryPrerequisite(page, {
      name: `${name} ${type}`,
      parentId: taxonomyShortcode("apparel"),
    });
    const product = await seedProductPrerequisite(page, {
      name: `${name} ${type} item`,
      brandName: "Fixture",
      categoryId: category.id,
    });
    await createEntityFixture(page, "inventory", {
      productId: product.id,
      ...own,
    });
  }
  const loose = await seedProductPrerequisite(page, {
    name: `${name} uncategorized item`,
    brandName: "Fixture",
  });
  await createEntityFixture(page, "inventory", { productId: loose.id, ...own });

  const sections = page.getByTestId("entity-card-grid").getByRole("region");
  const tops = sections.filter({ hasText: `${name} Tops` });
  await gotoAuthenticatedPage(
    page,
    `/inventory?owner=${owner.id}&view=shelf&groupBy=${encodeURIComponent(JSON.stringify([{ key: "category" }]))}`,
    tops,
  );
  await expect(sections.filter({ hasText: `${name} Outerwear` })).toHaveCount(
    1,
  );

  // Category is not Outerwear, through the picker's is / is not toggle.
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("button", { name: "Category", exact: true }).click();
  const picker = page.getByRole("combobox", { name: "Filter Category" });
  await page.getByRole("button", { name: "is not", exact: true }).click();
  await picker.fill(`${name} Outerwear`);
  // The pick applies at once; there is no Apply step.
  await page
    .getByRole("option", { name: new RegExp(`${name} Outerwear`) })
    .click();
  await page.keyboard.press("Escape");

  // The open Filters panel repeats the strip's chip in its Active section.
  await expect(
    page
      .getByRole("button", {
        name: new RegExp(`^Category: is not .*${name} Outerwear`),
      })
      .first(),
  ).toBeVisible();
  // No Outerwear section; the uncategorized item is not Outerwear, so it
  // stays, under the no-value section, which is always last.
  await expect(sections).toHaveText([
    /^Apparel/,
    new RegExp(`^${name} Tops`),
    /^Unassigned/,
  ]);
  await expect(
    sections
      .filter({ hasText: /^Unassigned/ })
      .getByRole("link", { name: new RegExp(`^${name} uncategorized item`) }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("categoryExclude")).toBeTruthy();

  // Hide keeps the grouping and excludes that section's value too.
  await tops.hover();
  await tops.getByRole("button", { name: /^Hide/ }).click();
  await expect(sections).toHaveText([/^Apparel/, /^Unassigned/]);
  const url = new URL(page.url());
  expect(JSON.parse(url.searchParams.get("groupBy") ?? "null")).toEqual([
    { key: "category" },
  ]);
  expect(url.searchParams.get("categoryExclude")?.split(",")).toHaveLength(2);
});

test("mobile list section headers stay pinned while their section scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const name = `Wardrobe pinned ${Date.now()}`;
  const { owner, location } = await seedWardrobePrerequisites(page, name);
  const category = await seedProductCategoryPrerequisite(page, {
    name: `${name} Tops`,
    parentId: taxonomyShortcode("apparel"),
  });
  await seedConcurrently(
    Array.from({ length: 14 }, (_, index) => index),
    async (index) => {
      const product = await createEntityFixture(page, "product", {
        name: `${name} shirt ${index}`,
        categoryId: category.id,
      });
      await createEntityFixture(page, "inventory", {
        productId: product.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
        ownershipMode: "explicit",
        ownerLedgerPartyId: owner.id,
      });
    },
  );
  const header = page
    .locator('[data-slot="list-section-header"]')
    .filter({ hasText: `${name} Tops` });
  await gotoAuthenticatedPage(
    page,
    `/inventory?owner=${owner.id}&categoryFeature=apparel&groupBy=${encodeURIComponent(JSON.stringify([{ key: "category" }]))}`,
    header,
  );
  const top = async () => (await header.boundingBox())?.y ?? -1;
  const before = await top();
  await page.mouse.wheel(0, 900);
  // The header pins under the app chrome instead of leaving with the
  // ancestor's clipping box (an `overflow-x-hidden` ancestor scrolled it away).
  await expect.poll(top).toBeLessThan(before);
  await expect.poll(top).toBeGreaterThanOrEqual(0);
  await page.mouse.wheel(0, 400);
  await expect(header).toBeInViewport();
});
