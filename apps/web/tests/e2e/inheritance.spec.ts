import { test } from "./support/e2e-test";
import { inheritanceContract } from "./support/inheritance-contract";

inheritanceContract();

test.describe("phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  inheritanceContract();
});
