import { expect, test } from "./e2e-test";
import { clearExpenseDatesInBrowser } from "./unknown-expense-date-flow";

test("bulk expense clearing sends null with keyboard controls", async ({
  page,
  baseURL,
}) => {
  const id = await clearExpenseDatesInBrowser(page, baseURL!);
  const refused = await page.request.patch(`/api/v1/expenses/${id}`, {
    headers: { Origin: baseURL! },
    data: { cost: 12 },
  });
  expect(refused.ok()).toBe(false);
  expect(await refused.text()).toContain("A date is required");
});
