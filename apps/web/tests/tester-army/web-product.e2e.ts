import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import {
  assertPersistedProductName,
  expectedProductName,
  productScenario,
  readBrowserCookies,
} from "../../tooling/tester-army/scenario";

test("web product rename persists after reopening", async ({
  app,
  agent,
  screen,
  browser,
}) => {
  const { productId, name, updatedName } = productScenario();
  await browser.setCookies(readBrowserCookies());
  await app.open("/products");
  await agent.act("Find and open the product named {name}", {
    params: { name },
  });
  await expect(screen.getByRole("heading", name)).toBeVisible();
  await agent.act(
    "Edit this product, change its Name to {name}, and save the changes",
    {
      params: { name: updatedName },
    },
  );
  await expect(screen.getByRole("dialog")).toBeHidden();
  await expect(
    screen.getByRole("heading", expectedProductName()),
  ).toBeVisible();
  await browser.reload();
  await app.open(`/products/${productId}`);
  await expect(
    screen.getByRole("heading", expectedProductName()),
  ).toBeVisible();
  await assertPersistedProductName();
});
