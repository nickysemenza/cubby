import { plantTaskConnection } from "./connected-records-contract";
import { expectViewportBounded } from "./e2e-helpers";
import { test } from "./e2e-test";

test("Plant connection paths fit the phone screen", async ({ page }) => {
  await plantTaskConnection(page);
  await expectViewportBounded(page);
});
