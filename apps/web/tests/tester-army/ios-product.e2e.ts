import { test } from "@e2e-dev/mobile";
import { expect } from "e2e";

import {
  assertPersistedProductName,
  expectedProductName,
  productScenario,
} from "../../tooling/tester-army/scenario";

test("iOS product rename persists after reopening", async ({
  app,
  agent,
  screen,
}) => {
  const { productId, name, updatedName } = productScenario();
  await app.open();
  await agent.act("Use Find to search for {name} and open that product", {
    params: { name },
  });
  await expect(screen.getByTestId("detail.product.edit")).toBeVisible();
  await expect(
    screen.getByTestId("detail.product").getByText(name),
  ).toBeVisible();
  await agent.act(
    "Edit this product, change its Name to {name}, and tap Save",
    {
      params: { name: updatedName },
    },
  );
  await expect(screen.getByTestId("detail.product.edit")).toBeVisible();
  await expect(
    screen.getByTestId("detail.product").getByText(expectedProductName()),
  ).toBeVisible();
  await app.restart();
  await agent.act("Use Find to search for {name} and open that product", {
    params: { name: updatedName },
  });
  await expect(screen.getByTestId("detail.product.edit")).toBeVisible();
  await expect(
    screen.getByTestId("detail.product").getByText(expectedProductName()),
  ).toBeVisible();
  await assertPersistedProductName(productId);
});
