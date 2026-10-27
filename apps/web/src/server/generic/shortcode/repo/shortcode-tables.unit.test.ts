import { describe, expect, it } from "vitest";

import { orderedEntityLockKinds } from "./shortcode-tables";

// Mixed embedding/connection pages must lock parents before dependent payloads.
describe("cross-kind payload lock order", () => {
  it("orders and deduplicates parents and remaining kinds consistently", () => {
    const kinds = [
      "expense",
      "product",
      "purchase",
      "financialTransaction",
      "project",
      "product",
    ];
    const expected = [
      "purchase",
      "project",
      "product",
      "expense",
      "financialTransaction",
    ];
    expect(orderedEntityLockKinds(kinds)).toEqual(expected);
    expect(orderedEntityLockKinds([...kinds].reverse())).toEqual(expected);
    expect(kinds[0]).toBe("expense");
  });
});
