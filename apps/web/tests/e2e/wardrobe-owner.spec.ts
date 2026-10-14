import { seedWardrobePrerequisites } from "./fixtures-catalog";
import { chooseOption, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

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
    page.getByRole("columnheader", { name: /effectiveOwnership column Owner/ }),
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
    page.getByLabel("Current ownership", { exact: true }),
  );
  const current = page.getByLabel("Current ownership", { exact: true });
  await expect(current).toHaveText(`Confirmed: ${name} owner`);
  // Ownership is a readable fact until the member chooses to edit it.
  await expect(
    page.getByRole("button", { name: "Save ownership", exact: true }),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: "Change ownership", exact: true })
    .click();
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Ownership", exact: true }),
    "No individual owner",
  );
  // The server owns the quantity bound; the client shows its refusal.
  await page
    .getByRole("spinbutton", {
      name: "Quantity to assign; leave blank for entire entry",
    })
    .fill("4");
  await page
    .getByRole("button", { name: "Save ownership", exact: true })
    .click();
  await expect(
    page.getByText(/Cannot reassign 4; only 3 is available/).first(),
  ).toBeVisible();
  await page
    .getByRole("spinbutton", {
      name: "Quantity to assign; leave blank for entire entry",
    })
    .fill("");
  await page
    .getByRole("button", { name: "Save ownership", exact: true })
    .click();
  await expect(
    page.getByText("Ownership saved", { exact: true }),
  ).toBeVisible();
  await expect(current).toHaveText("No individual owner");

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
});
