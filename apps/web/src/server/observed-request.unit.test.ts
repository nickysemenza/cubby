import { describe, expect, it, vi } from "vitest";
import {
  isObservedCancellation,
  recordObservedInput,
} from "./observed-request";

describe("observed request input redaction", () => {
  it("redacts URL/URI and credential values while retaining safe fields", () => {
    const setAttribute = vi.fn();
    recordObservedInput({ setAttribute } as never, {
      sourceUrl: "https://example.test/recipe?token=secret",
      callbackUri: "https://example.test/callback",
      apiKey: "secret",
      query: "pasta",
    });

    expect(setAttribute).toHaveBeenCalledWith(
      "rpc.input.sourceUrl",
      "[redacted]",
    );
    expect(setAttribute).toHaveBeenCalledWith(
      "rpc.input.callbackUri",
      "[redacted]",
    );
    expect(setAttribute).toHaveBeenCalledWith("rpc.input.apiKey", "[redacted]");
    expect(setAttribute).toHaveBeenCalledWith("rpc.input.query", "pasta");
  });
});

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
