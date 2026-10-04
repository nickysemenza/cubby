import { and, eq, isNull } from "drizzle-orm";

import { expense, entityLink } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { getFixtureDb } from "./fixtures-core";

const line = {
  date: "2026-09-01",
  lineKind: "principal",
  economicRole: "vendor",
  costType: "materials",
  trade: "other",
} as const;

test.describe("split and attach, with the server's rules", () => {
  test("a split saves only parts that add up to the original in whole cents", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const db = getFixtureDb();
    const stamp = Date.now();
    const vendor = await insertWithShortcode(db, "vendor", {
      name: `Synthetic split vendor ${stamp}`,
    });
    const target = await insertWithShortcode(db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
    });
    const source = await insertWithShortcode(db, "expense", {
      ...line,
      name: `Synthetic kit ${stamp}`,
      cost: 30,
      purchaseId: target.id,
    });

    await gotoAuthenticatedPage(
      page,
      `/expenses/${source.shortcode}`,
      page.getByRole("button", { name: "Split..." }),
    );
    await page.getByRole("button", { name: "Split..." }).click();
    const dialog = page.getByRole("dialog", { name: /^Split / });
    await dialog.getByRole("spinbutton", { name: "Part 1 cost" }).fill("10");
    await dialog
      .getByRole("textbox", { name: "Part 2 name" })
      .fill(`Synthetic blade ${stamp}`);
    // A cent short: the server's check refuses, and the button stays off.
    await dialog.getByRole("spinbutton", { name: "Part 2 cost" }).fill("19.99");
    await expect(dialog.getByText(/\$0\.01 under the original/)).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Split into 2" }),
    ).toBeDisabled();

    await dialog.getByRole("spinbutton", { name: "Part 2 cost" }).fill("20");
    await expect(
      dialog.getByText("Parts add up to the original cost."),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Split into 2" }).click();
    await expect(page).toHaveURL(new RegExp(`/purchases/${target.shortcode}`));

    const live = await getDb(db)
      .select({ cost: expense.cost })
      .from(expense)
      .where(and(eq(expense.purchaseId, target.id), isNull(expense.deletedAt)));
    expect(live.map((row) => row.cost).sort()).toEqual([10, 20]);
    const original = await getDb(db)
      .select({ deletedAt: expense.deletedAt })
      .from(expense)
      .where(eq(expense.id, source.id));
    expect(original[0]?.deletedAt).not.toBeNull();
  });

  test("attaching expenses totals the selection and moves only what was chosen", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const db = getFixtureDb();
    const stamp = Date.now();
    const vendor = await insertWithShortcode(db, "vendor", {
      name: `Synthetic attach vendor ${stamp}`,
    });
    const target = await insertWithShortcode(db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
    });
    const free = await insertWithShortcode(db, "expense", {
      ...line,
      name: `Synthetic loose board ${stamp}`,
      cost: 12.5,
    });
    const untouched = await insertWithShortcode(db, "expense", {
      ...line,
      name: `Synthetic other board ${stamp}`,
      cost: 3,
    });

    await gotoAuthenticatedPage(
      page,
      `/purchases/${target.shortcode}`,
      page.getByRole("button", { name: "Attach existing expenses" }),
    );
    await page
      .getByRole("button", { name: "Attach existing expenses" })
      .click();
    const dialog = page.getByRole("dialog", { name: /^Attach expenses to / });
    await dialog.getByPlaceholder("Search expense names…").fill(`${stamp}`);
    await dialog
      .getByRole("row")
      .filter({ hasText: `Synthetic loose board ${stamp}` })
      .getByRole("checkbox")
      .click();
    await expect(
      dialog.getByText(/1 expense selected · \$12\.50/),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Attach 1" }).click();
    await expect(dialog).toHaveCount(0);

    const moved = await getDb(db)
      .select({ purchaseId: expense.purchaseId })
      .from(expense)
      .where(eq(expense.id, free.id));
    expect(moved[0]?.purchaseId).toBe(target.id);
    const left = await getDb(db)
      .select({ purchaseId: expense.purchaseId })
      .from(expense)
      .where(eq(expense.id, untouched.id));
    expect(left[0]?.purchaseId).toBeNull();
  });

  test("attaching products links only the checked one and hides it afterwards", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const db = getFixtureDb();
    const stamp = Date.now();
    const vendor = await insertWithShortcode(db, "vendor", {
      name: `Synthetic product vendor ${stamp}`,
    });
    const target = await insertWithShortcode(db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
    });
    const chosen = await insertWithShortcode(db, "product", {
      name: `Synthetic chosen saw ${stamp}`,
      manufacturer: "Synthetic Maker",
    });
    await insertWithShortcode(db, "product", {
      name: `Synthetic skipped saw ${stamp}`,
      manufacturer: "Synthetic Maker",
    });

    await gotoAuthenticatedPage(
      page,
      `/purchases/${target.shortcode}`,
      page.getByRole("button", { name: "Attach products" }),
    );
    await page.getByRole("button", { name: "Attach products" }).click();
    const dialog = page.getByRole("dialog", { name: /^Attach products to / });
    await dialog.getByPlaceholder("Search products…").fill(`saw ${stamp}`);
    await dialog
      .getByRole("row")
      .filter({ hasText: `Synthetic chosen saw ${stamp}` })
      .getByRole("checkbox")
      .click();
    await dialog.getByRole("button", { name: "Attach 1" }).click();
    await expect(dialog).toHaveCount(0);

    const links = await getDb(db)
      .select({ toEntityId: entityLink.toEntityId })
      .from(entityLink)
      .where(
        and(
          eq(entityLink.fromEntityId, target.id),
          isNull(entityLink.deletedAt),
        ),
      );
    expect(links.map((link) => link.toEntityId)).toEqual([chosen.id]);

    // Reopened, the attached product is no longer offered; the other still is.
    await page.getByRole("button", { name: "Attach products" }).click();
    const reopened = page.getByRole("dialog", { name: /^Attach products to / });
    await reopened.getByPlaceholder("Search products…").fill(`saw ${stamp}`);
    await expect(
      reopened.getByText(`Synthetic skipped saw ${stamp}`),
    ).toBeVisible();
    await expect(
      reopened.getByText(`Synthetic chosen saw ${stamp}`),
    ).toHaveCount(0);
  });
});
