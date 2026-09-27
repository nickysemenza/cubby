import { seedSplitSettlementPrerequisite } from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("allocates one statement charge across two Purchases after review", async ({
  page,
}) => {
  const seed = await seedSplitSettlementPrerequisite(
    page,
    `Synthetic Outfitters ${Date.now()}`,
  );
  await gotoAuthenticatedPage(
    page,
    `/purchases/${seed.first.shortcode}`,
    page.getByRole("button", { name: "Match statement activity" }),
  );
  await page.getByRole("button", { name: "Match statement activity" }).click();
  const dialog = page.getByRole("dialog", { name: "Match statement activity" });
  await expect(dialog.getByText("$91.00")).toBeVisible();
  await dialog.getByRole("button", { name: /Synthetic Outfitters/ }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Purchase code 1" }),
  ).toHaveValue(seed.first.shortcode);
  await dialog
    .getByRole("textbox", { name: "Purchase code 2" })
    .fill(seed.second.shortcode);
  await dialog.getByRole("button", { name: "Save allocation" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("row", { name: /\$42\.50of \$91\.00/ }),
  ).toBeVisible();
  await gotoAuthenticatedPage(
    page,
    `/purchases/${seed.second.shortcode}`,
    page.getByRole("row", { name: /\$48\.50of \$91\.00/ }),
  );
});
