import { describe, expect, it } from "vitest";

import { isThrottleError } from "./embedding";

describe("isThrottleError", () => {
  // Regression: an immediate redelivery after a throttle re-pays the embed —
  // the queue consumer only delays a retry (see `consume.ts`) when this
  // classifier recognizes the provider's rate-limit signature. A false
  // negative here turns a throttle into an instant, unpaid-for redelivery
  // loop instead of a backed-off retry.
  it.each([
    [
      "Vectorize mutation rate limit (VECTOR_UPSERT_ERROR 40041)",
      new Error("VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests"),
      true,
    ],
    [
      "AI Gateway wholesale rate limit (429 / 2018)",
      new Error('429 [{"code":2018,"message":"Wholesale Rate limited"}]'),
      true,
    ],
    [
      "a genuine connection outage, not a throttle",
      new Error("connect ETIMEDOUT"),
      false,
    ],
    [
      "a structural message-only error (no Error instance)",
      { message: "Too Many Requests" },
      true,
    ],
    ["a bare string with no throttle signature", "nope", false],
  ])("%s", (_name, error, expected) => {
    expect(isThrottleError(error)).toBe(expected);
  });
});
