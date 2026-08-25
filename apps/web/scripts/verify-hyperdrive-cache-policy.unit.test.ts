import { describe, expect, it } from "vitest";
import {
  assertHyperdriveCachePolicy,
  parseWranglerJson,
} from "./verify-hyperdrive-cache-policy";

describe("Hyperdrive cache policy verification", () => {
  it("parses Wrangler output before checking the desired policy", () => {
    const config = parseWranglerJson(`Wrangler banner\n{
      "id": "cached-id",
      "caching": {
        "disabled": false,
        "max_age": 300,
        "stale_while_revalidate": 30
      }
    }`);
    expect(() => assertHyperdriveCachePolicy(config)).not.toThrow();
  });

  it("rejects disabled or drifted cache settings", () => {
    expect(() =>
      assertHyperdriveCachePolicy({
        id: "cached-id",
        caching: {
          disabled: true,
          max_age: 60,
          stale_while_revalidate: 0,
        },
      }),
    ).toThrow(/policy drift.*caching must be enabled.*max_age.*stale_while/u);
  });
});
