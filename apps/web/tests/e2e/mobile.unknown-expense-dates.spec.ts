import { test } from "./e2e-test";
import { clearExpenseDatesInBrowser } from "./unknown-expense-date-flow";

test("unknown expense dates remain usable in the phone bulk dialog", async ({
  page,
  baseURL,
}) => {
  await clearExpenseDatesInBrowser(page, baseURL!);
});
