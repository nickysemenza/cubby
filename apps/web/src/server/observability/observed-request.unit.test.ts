import { describe, expect, it } from "vitest";

import {
  isObservedCancellation,
  parseObservedFailure,
} from "./observed-request";

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

  it("preserves observable errors and JSON failures while sanitizing other values", () => {
    const error = new Error("broken");
    expect(parseObservedFailure(error)).toBe(error);
    expect(parseObservedFailure({ code: "REMOTE_FAILURE" })).toEqual({
      code: "REMOTE_FAILURE",
    });
    expect(parseObservedFailure(Symbol("private failure"))).toMatchObject({
      message: "A non-serializable value was thrown",
    });
    const circular = { message: "Provider failed", cause: {} };
    circular.cause = circular;
    expect(parseObservedFailure(circular)).toEqual(circular);
    const hostile = {
      get message() {
        throw new Error("Cannot read message");
      },
    };
    const observed = parseObservedFailure(hostile);
    expect(observed).toBeInstanceOf(Error);
    if (!(observed instanceof Error))
      throw new Error("Expected an observable Error");
    expect(observed.message).toBe("A non-serializable value was thrown");
    expect(observed.cause).toBe(hostile);
  });
});
