import { and, eq, isNull } from "drizzle-orm";

import { expense } from "~/server/db/schema";
import { getDb } from "~/server/db/helpers";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { gotoDetailActions, chooseOption } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { getFixtureDb } from "./fixtures/core";

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
      cost: 3000n,
      purchaseId: target.id,
    });

    await gotoDetailActions(
      page,
      `/expenses/${source.shortcode}`,
      page.getByRole("button", { name: "Split..." }),
    );
    await page.getByRole("button", { name: "Split..." }).click();
    const dialog = page.getByRole("dialog", { name: /^Split / });
    for (const index of [1, 2]) {
      await chooseOption(
        page,
        dialog.getByRole("combobox", {
          name: `Part ${index} receipt role`,
          exact: true,
        }),
        "Item or service",
      );
    }
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
      cost: 1250n,
    });
    const untouched = await insertWithShortcode(db, "expense", {
      ...line,
      name: `Synthetic other board ${stamp}`,
      cost: 300n,
    });

    await gotoDetailActions(
      page,
      `/purchases/${target.shortcode}#work`,
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
});
