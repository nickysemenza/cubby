import { expect, test } from "./e2e-test";

test("Tools gallery, Usage view, and legacy matrix route share one workbench", async ({
  page,
}) => {
  await page.goto("/tools");
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: "Tools" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Gallery view" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("textbox", { name: "Search inventoried tools" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Usage view" }).click();
  await expect(page).toHaveURL(/\/tools\?view=usage/);
  await expect(
    page.getByText("Projects", { exact: true }).first(),
  ).toBeVisible();

  await page.goto(
    "/projects/tools?floor=0&project=legacy&tool=saw&page=2&completed=2025&group=manufacturer",
  );
  await expect(page).toHaveURL((url) => {
    return (
      url.pathname === "/tools" &&
      url.searchParams.get("view") === "usage" &&
      url.searchParams.get("floor") === "0" &&
      url.searchParams.get("project") === "legacy" &&
      url.searchParams.get("tool") === "saw" &&
      url.searchParams.get("page") === "2" &&
      url.searchParams.get("completed") === '"2025"' &&
      url.searchParams.get("usageGroup") === "manufacturer"
    );
  });
});
