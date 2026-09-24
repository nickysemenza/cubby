import { describe, expect, it } from "vitest";

import { HYPERDRIVE_CACHE_POLICY } from "./hyperdrive-cache-policy";

describe("Hyperdrive cache policy", () => {
  it("keeps the browser strong beyond the complete bounded-stale window", () => {
    expect(HYPERDRIVE_CACHE_POLICY.freshReadSeconds).toBeGreaterThan(
      HYPERDRIVE_CACHE_POLICY.maxAgeSeconds +
        HYPERDRIVE_CACHE_POLICY.staleWhileRevalidateSeconds,
    );
  });
});
