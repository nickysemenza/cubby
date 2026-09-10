import { expect, test } from "./e2e-test";

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`declared transaction controls work on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto("/financial-transactions?create=true");
    const dialog = page.getByRole("dialog", { name: "New Transaction" });
    await expect(dialog).toBeVisible();
    const kind = dialog.getByRole("combobox", { name: /^kind$/i });
    await dialog.getByText("Kind", { exact: true }).click();
    await expect(kind).toBeFocused();
    await kind.fill("refund");
    await page.getByRole("option", { name: "refund", exact: true }).click();
    await expect(kind).toHaveValue("refund");
    const amount = dialog.getByRole("spinbutton", { name: "Amount" });
    await amount.fill("12.34");
    await expect(amount).toHaveValue("12.34");
    const notes = dialog.getByRole("textbox", { name: "Notes", exact: true });
    await notes.fill("Temporary fixture evidence");
    await notes.fill("");
    await expect(notes).toHaveValue("");
    await expect(
      dialog.getByRole("button", { name: "Open calendar" }),
    ).toHaveCount(2);
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    await expect(
      dialog.getByRole("heading", { name: "New Transaction" }),
    ).toBeInViewport();
    await kind.scrollIntoViewIfNeeded();
    await dialog.screenshot({
      path: testInfo.outputPath(`transaction-${viewport.name}.png`),
    });
  });
}
