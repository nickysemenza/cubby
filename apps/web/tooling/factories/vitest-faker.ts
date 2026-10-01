import type { Faker } from "@faker-js/faker";
import { expect, onTestFailed } from "vitest";

import { fakerFromSeed, hashSeed } from "./faker";

/**
 * The running Vitest test's seeded Faker: seeded from the test file and full
 * name, so a rerun draws the same values, and the seed is printed when the
 * test fails. Call inside a test or hook (it registers a failure hook).
 */
export function testFaker(): Faker {
  const { testPath, currentTestName } = expect.getState();
  const seed = hashSeed(testPath ?? "", currentTestName ?? "");
  onTestFailed(() => {
    console.error(
      `[faker] ${currentTestName ?? "test"} used seed ${seed} (fakerFromSeed(${seed}) replays it)`,
    );
  });
  return fakerFromSeed(seed);
}
