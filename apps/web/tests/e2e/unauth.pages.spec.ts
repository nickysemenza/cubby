import { expect, test } from "./e2e-test";

test("public home renders and protected detail redirects before rendering", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Cubby/i);

  await page.goto("/products/PRD-2222");
  await expect(page).toHaveURL(/\/auth\/sign-in/);
});
