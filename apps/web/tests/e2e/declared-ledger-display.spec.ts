import { seedLedgerDisplayPrerequisite } from "./e2e-fixtures";
import { expect, test } from "./e2e-test";

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`declared ledger fields preserve links and details on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const name = `Ledger display ${viewport.name} ${Date.now()}`;
    const { from, to, transfer, account } = await seedLedgerDisplayPrerequisite(
      page,
      name,
    );
    await page.goto(`/ledger-parties?q=${encodeURIComponent(from.name)}`);
    await expect(
      page.getByRole("link", { name: from.name, exact: true }).first(),
    ).toBeVisible();
    if (viewport.name === "desktop")
      await expect(
        page.getByText(`${name} party notes`, { exact: true }),
      ).toBeVisible();
    await page.goto(`/ledger-parties/${from.id}`);
    await expect(
      page.getByText(`${name} party notes`, { exact: true }),
    ).toBeVisible();
    await page.goto(`/ledger-transfers?fromPartyId=${from.id}`);
    await expect(
      page.getByRole("link", { name: from.name, exact: true }).first(),
    ).toBeVisible();
    await page.goto(`/ledger-transfers/${transfer.id}`);
    await expect(
      page.getByRole("link", { name: from.name, exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: to.name, exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(`${name} transfer notes`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("$12.34", { exact: true }).first(),
    ).toBeVisible();
    await page.goto("/financial-accounts");
    await expect(
      page.getByRole("link", { name: `${name} cash`, exact: true }),
    ).toBeVisible();
    await page.goto(`/financial-accounts/${account.id}`);
    await expect(
      page.getByRole("link", { name: from.name, exact: true }),
    ).toHaveAttribute("href", `/ledger-parties/${from.id}`);
    await expect(
      page.getByText(`${name} account notes`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Cash", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width + 1);
    await page.screenshot({
      path: testInfo.outputPath(`ledger-${viewport.name}.png`),
    });
  });
}
