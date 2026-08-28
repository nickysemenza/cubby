import { describe, expect, it } from "vitest";

import { isObservedCancellation } from "./observed-request";

describe("observed request cancellation", () => {
  it("recognizes browser, server, and TanStack cancellation errors", () => {
    expect(
      isObservedCancellation(new DOMException("cancelled", "AbortError")),
    ).toBe(true);
    const serverAbort = new Error("cancelled");
    serverAbort.name = "AbortError";
    expect(isObservedCancellation(serverAbort)).toBe(true);
    const tanstackCancellation = new Error("cancelled");
    tanstackCancellation.name = "CancelledError";
    expect(isObservedCancellation(tanstackCancellation)).toBe(true);
    expect(isObservedCancellation(new Error("broken"))).toBe(false);
  });
});
