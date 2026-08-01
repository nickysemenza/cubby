import { describe, expect, it } from "vitest";
import { getErrorMessage } from "./error-utils";

describe("getErrorMessage", () => {
  it("preserves strings and Error messages", () => {
    expect(getErrorMessage("plain failure")).toBe("plain failure");
    expect(getErrorMessage(new Error("typed failure"))).toBe("typed failure");
  });

  it("preserves structurally compatible DOMException messages", () => {
    const domException = {
      name: "AbortError",
      message: "Browser navigation was interrupted",
    };
    expect(getErrorMessage(domException)).toBe(
      "Browser navigation was interrupted",
    );
  });

  it("uses a safe fallback for non-errors", () => {
    expect(getErrorMessage({ reason: "not a message" })).toBe(
      "An unknown error occurred",
    );
  });
});
