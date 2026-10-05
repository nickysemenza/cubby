import { eq } from "drizzle-orm";

import { entityLink, product } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { linkValues } from "~/server/repo/entity-links";

import {
  escapeRegExp,
  gotoAuthenticatedPage,
  openCommandPalette,
  uniqueName,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { createEntityFixture, getFixtureDb } from "./fixtures-core";

// The full search page and the command menu render one Product family (its
// direct placements, kit-content placements, and matched records) from the
// same `SearchResultGroup`. Both must reach the same family, the same child
// rows, and the same placement records; the menu alone caps each child
// category and hands the remainder to full search.
test("the search page and command menu open the same Product family", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const name = uniqueName(testInfo, "Family drill");
  const shelfName = uniqueName(testInfo, "Family shelf");
  const shelf = await createEntityFixture(page, "location", {
    name: shelfName,
  });
  const bin = await createEntityFixture(page, "location", {
    name: uniqueName(testInfo, "Family bin"),
  });
  const kit = await createEntityFixture(page, "product", { name });
  const battery = await createEntityFixture(page, "product", {
    name: uniqueName(testInfo, "Spare cell"),
  });
  const direct = await createEntityFixture(page, "inventory", {
    productId: kit.id,
    locationId: shelf.id,
    amount: { value: 1.5, unit: "kg" },
  });
  const kitContent = await createEntityFixture(page, "inventory", {
    productId: battery.id,
    locationId: bin.id,
    amount: { value: 2, unit: "each" },
  });
  const chores = ["oil", "sharpen", "store"].map((verb) => `${name} ${verb}`);
  for (const chore of chores)
    await createEntityFixture(page, "task", {
      name: chore,
      trade: "other",
      subjectProductId: kit.id,
    });
  const db = getDb(getFixtureDb());
  const [kitRow, batteryRow] = await Promise.all(
    [kit.id, battery.id].map(async (shortcode) => {
      const row = await db.query.product.findFirst({
        where: eq(product.shortcode, shortcode),
        columns: { id: true },
      });
      if (!row) throw new Error(`Product ${shortcode} was not seeded.`);
      return row;
    }),
  );
  await db
    .insert(entityLink)
    .values(linkValues("productComponent", kitRow!.id, batteryRow!.id, 2));

  const regionName = `${name} placements and matching records`;
  const toggleName = new RegExp(`^Expand ${escapeRegExp(regionName)}$`);

  // Full search: every child, each a link to its own record.
  await gotoAuthenticatedPage(
    page,
    `/search?${new URLSearchParams({ q: name })}`,
  );
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  const summary =
    /1 direct placement · Kit contents placed · .+; .+ · 3 matching records$/;
  const pageSummary = await page.getByText(summary).textContent();
  await page.getByRole("button", { name: toggleName }).click();
  const pageFamily = page.getByRole("group", { name: regionName });
  const pageChildren = pageFamily.getByRole("link");
  await expect(pageChildren).toHaveCount(2 + chores.length);
  const pageDirect = pageFamily.getByRole("link", {
    name: new RegExp(escapeRegExp(direct.id)),
  });
  await expect(pageDirect).toContainText(shelfName);
  await expect(pageDirect).toContainText("kg · Stock");
  const pageKit = pageFamily.getByRole("link", {
    name: new RegExp(escapeRegExp(kitContent.id)),
  });
  await expect(pageKit).toContainText("2× kit content");
  const pageDirectText = await pageDirect.textContent();
  const pageKitText = await pageKit.textContent();
  for (const chore of chores)
    await expect(
      pageFamily.getByRole("link", { name: new RegExp(escapeRegExp(chore)) }),
    ).toBeVisible();
  await pageFamily
    .getByRole("link", { name: new RegExp(escapeRegExp(kitContent.id)) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/inventory/${kitContent.id}$`));

  // Command menu: the same family, keyboard-driven, capped at two placements
  // and two matched records.
  const palette = await openCommandPalette(page);
  const input = palette.getByPlaceholder("Search or jump to a page…");
  await input.fill(name);
  // Task children also start with the Product's name; only the parent ends
  // with its shortcode.
  const parent = palette.getByRole("option", {
    name: new RegExp(`^${escapeRegExp(name)}.*${escapeRegExp(kit.id)}$`),
  });
  await expect(parent).toHaveAttribute("aria-expanded", "false");
  await expect(parent).toHaveAttribute("aria-selected", "true");
  // Both surfaces word the family identically (one shared formatter).
  await expect(palette.getByText(summary)).toHaveText(pageSummary!);
  // Focus stays in the input: the arrows disclose the selected family, but
  // only from a collapsed caret at the end of the text.
  await input.press("ArrowRight");
  await expect(parent).toHaveAttribute("aria-expanded", "true");
  const caret = () =>
    input.evaluate((element: HTMLInputElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]);
  await input.evaluate((element: HTMLInputElement) =>
    element.setSelectionRange(3, 3),
  );
  await input.press("ArrowLeft");
  expect(await caret()).toEqual([2, 2]);
  await input.press("Shift+ArrowLeft");
  expect(await caret()).toEqual([1, 2]);
  await expect(parent).toHaveAttribute("aria-expanded", "true");
  await input.evaluate((element: HTMLInputElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await input.press("Shift+ArrowLeft");
  await expect(parent).toHaveAttribute("aria-expanded", "true");
  await input.evaluate((element: HTMLInputElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await input.press("ArrowLeft");
  await expect(parent).toHaveAttribute("aria-expanded", "false");
  await input.evaluate((element: HTMLInputElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await input.press("ArrowRight");
  const menuFamily = palette.getByRole("group", { name: regionName });
  await expect(menuFamily).toBeVisible();
  await expect(
    menuFamily.getByRole("option", {
      name: new RegExp(escapeRegExp(direct.id)),
    }),
  ).toHaveText(pageDirectText!);
  await expect(
    menuFamily.getByRole("option", {
      name: new RegExp(escapeRegExp(kitContent.id)),
    }),
  ).toHaveText(pageKitText!);
  await expect(
    menuFamily.getByRole("option", { name: /^See 1 more in full search$/ }),
  ).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/inventory/${direct.id}$`));

  // Pointer disclosure, and a kit content opens its own placement record.
  const pointer = await openCommandPalette(page);
  await pointer.getByPlaceholder("Search or jump to a page…").fill(name);
  await pointer.getByRole("button", { name: toggleName }).click();
  const collapse = pointer.getByRole("button", {
    name: new RegExp(`^Collapse ${escapeRegExp(regionName)}$`),
  });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.click();
  await expect(pointer.getByRole("group", { name: regionName })).toHaveCount(0);
  await pointer.getByRole("button", { name: toggleName }).click();
  await pointer
    .getByRole("group", { name: regionName })
    .getByRole("option", { name: new RegExp(escapeRegExp(kitContent.id)) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/inventory/${kitContent.id}$`));

  // The menu's overflow row hands off to the full page for the same query.
  const again = await openCommandPalette(page);
  await again.getByPlaceholder("Search or jump to a page…").fill(name);
  await again.getByRole("button", { name: toggleName }).click();
  await again
    .getByRole("option", { name: /^See 1 more in full search$/ })
    .click();
  await expect(page).toHaveURL(/\/search\?/);
  await expect(
    page.getByRole("searchbox", { name: "Search Cubby" }),
  ).toHaveValue(name);
});
