import { test } from "./e2e-test";
import { clearExpenseDatesInBrowser } from "./unknown-expense-date-flow";

test("bulk expense clearing sends null with keyboard controls", async ({
  page,
  baseURL,
}) => {
  await clearExpenseDatesInBrowser(page, baseURL!);
});
