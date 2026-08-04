import { describe, expect, it } from "vitest";
import {
  assertHyperdriveCacheDisabled,
  extractHyperdriveId,
} from "./verify-hyperdrive-cache";

describe("Hyperdrive cache policy", () => {
  it("reads the production binding id from JSONC", () => {
    expect(
      extractHyperdriveId(`
        // connection pooling only
        "hyperdrive": [{
          "binding": "HYPERDRIVE",
          "id": "hd-test-id"
        }]
      `),
    ).toBe("hd-test-id");
  });

  it("accepts only an explicitly disabled query cache", () => {
    expect(() =>
      assertHyperdriveCacheDisabled({ caching: { disabled: true } }),
    ).not.toThrow();
    expect(() =>
      assertHyperdriveCacheDisabled({ caching: { disabled: false } }),
    ).toThrow(/must remain disabled/u);
    expect(() => assertHyperdriveCacheDisabled({})).toThrow(
      /must remain disabled/u,
    );
  });
});
