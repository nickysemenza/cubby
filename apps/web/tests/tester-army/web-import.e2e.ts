import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import {
  assertImportedPurchase,
  importScenario,
  readBrowserCookies,
} from "../../tooling/tester-army/scenario";

test("web import of a saved order confirmation through the live agent", async ({
  app,
  agent,
  screen,
  browser,
}) => {
  const { vendorShortcode, vendorName, orderId } = importScenario();
  await browser.setCookies(readBrowserCookies());
  await app.open(`/vendors/${vendorShortcode}`);
  await expect(screen.getByRole("heading", vendorName)).toBeVisible();
  await agent.act(
    "Import the saved order confirmation for order {order}, then open the import it starts",
    { params: { order: orderId } },
  );
  // The run page streams the coordinator's live conversation.
  await expect(screen.getByRole("heading", "Live agent")).toBeVisible();
  await assertImportedPurchase();
  await browser.reload();
  await expect(screen.getByRole("heading", "Purchases changed")).toBeVisible();
});
