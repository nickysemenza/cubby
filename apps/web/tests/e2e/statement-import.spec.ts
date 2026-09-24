import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("full-size statement CSV saves in bounded batches and replays without duplicate rows", async ({
  page,
}) => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const csv = [
    "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id",
    ...Array.from(
      { length: 501 },
      (_, index) =>
        `9/21/2026,Synthetic Outfitters,Clothing,Fixture Visa,ORDER ${unique} ${index + 1},,-1.00,,,,row-${index + 1}`,
    ),
  ].join("\n");
  const upload = async () => {
    await page.getByLabel("Statement CSV file").setInputFiles({
      name: `fixture-${unique}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await expect(
      page.getByRole("heading", { name: /501 source rows/ }),
    ).toBeVisible();
  };

  await gotoAuthenticatedPage(page, "/statement-rows/import");
  await upload();
  await page.getByRole("button", { name: "Save 501 source rows" }).click();
  await expect(page.getByText("501 new source rows")).toBeVisible();

  await upload();
  await page.getByRole("button", { name: "Save 501 source rows" }).click();
  await expect(page.getByText("0 new source rows")).toBeVisible();
  await expect(
    page.getByText("501 already present or indistinguishable"),
  ).toBeVisible();
});

test("unfamiliar statement CSV requires reviewed column and sign mapping", async ({
  page,
}) => {
  const source = `fixture-${Date.now()}`;
  await gotoAuthenticatedPage(page, "/statement-rows/import");
  await page.getByLabel("Statement CSV file").setInputFiles({
    name: `${source}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      "When,Details,Total,Flow\n2026-09-21,SYNTHETIC ORDER,29.99,out\n2026-09-22,SYNTHETIC REFUND,5.00,in",
    ),
  });
  const mapping = page.getByRole("region", { name: "Map statement columns" });
  await expect(mapping).toBeVisible();
  await mapping.getByLabel("Source name").fill(source);
  await mapping
    .getByLabel("Account name (for a single-account file)")
    .fill("Fixture checking (...4242)");
  await mapping.getByLabel("Date column").selectOption("When");
  await mapping.getByLabel("Description column").selectOption("Details");
  await mapping.getByLabel("Direction column").selectOption("Flow");
  await mapping
    .getByLabel("Amount convention")
    .selectOption("direction-column");
  await mapping.getByLabel("Charge value").fill("out");
  await mapping.getByLabel("Credit value").fill("in");
  await mapping.getByRole("button", { name: "Preview mapped rows" }).click();
  await expect(
    page.getByRole("heading", { name: new RegExp(`2 source rows.*${source}`) }),
  ).toBeVisible();
  await expect(page.getByText("$29.99")).toBeVisible();
  await page.getByRole("button", { name: "Save 2 source rows" }).click();
  await expect(page.getByText("2 new source rows")).toBeVisible();
});
