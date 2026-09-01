import { seedLocationPrerequisite } from "./e2e-fixtures";
import { expect, test } from "./e2e-test";

const toLegacy = (code: string): string =>
  `${code[0]}-${code.slice(code.indexOf("-") + 1)}`;

test("a location scan redirects to the canonical detail, canonical and legacy", async ({
  page,
}) => {
  const name = `E2E Scan Location ${Date.now()}`;
  const location = await seedLocationPrerequisite(page, name);
  const code = location.id;

  await page.goto(`/${code}`);
  await expect(page).toHaveURL(new RegExp(`/locations/${code}$`));
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  await page.goto(`/${toLegacy(code)}`);
  await expect(page).toHaveURL(new RegExp(`/locations/${code}$`));
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
});
