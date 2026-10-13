import { entityApi } from "./entity-api";
import { expect, test } from "./e2e-test";
import { clearExpenseDatesInBrowser } from "./unknown-expense-date-flow";

test("bulk expense clearing sends null with keyboard controls", async ({
  page,
  baseURL,
}) => {
  const id = await clearExpenseDatesInBrowser(page, baseURL!);
  const refused = await entityApi(page.request).update(
    "expense",
    id,
    { cost: 12 },
    { headers: { Origin: baseURL! } },
  );
  expect(refused.ok()).toBe(false);
  expect(await refused.text()).toContain("A date is required");
});
