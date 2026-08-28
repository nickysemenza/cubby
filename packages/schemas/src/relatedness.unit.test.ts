import { describe, expect, it } from "vitest";

import {
  activeRelatednessPairKeys,
  relatednessPairRegistry,
} from "./relatedness";

describe("active relatedness pairs", () => {
  it("keeps the non-empty schema tuple aligned with registry flags", () => {
    const activeRegistryKeys = Object.entries(relatednessPairRegistry).flatMap(
      ([key, pair]) => (pair.active ? [key] : []),
    );

    expect(activeRelatednessPairKeys).not.toHaveLength(0);
    expect(activeRelatednessPairKeys).toEqual(activeRegistryKeys);
  });
});
