import { describe, expect, it } from "vitest";
import {
  getAppErrorDetails,
  isDynamicImportError,
  isSupersededViewTransitionError,
  SUPERSEDED_VIEW_TRANSITION_MESSAGE,
} from "./error-utils";

describe("getAppErrorDetails", () => {
  it.each([
    ["plain failure", "plain failure"],
    [new Error("typed failure"), "typed failure"],
    [
      { name: "AbortError", message: "DOM operation failed" },
      "DOM operation failed",
    ],
  ])("preserves an error message", (error, expected) => {
    expect(getAppErrorDetails(error)).toEqual({ message: expected });
  });

  it("keeps the validation issues a Start refusal reported", () => {
    expect(
      getAppErrorDetails({
        message: "name: Required",
        data: {
          code: "BAD_REQUEST",
          reason: "INVALID_INPUT",
          validationIssues: [
            {
              code: "invalid_type",
              path: ["data", "name"],
              message: "Required",
            },
          ],
        },
      }).validationIssues,
    ).toEqual([
      { code: "invalid_type", path: ["data", "name"], message: "Required" },
    ]);
  });

  it("reads a malformed validation payload as no issues rather than crashing", () => {
    expect(
      getAppErrorDetails({
        message: "broken",
        data: { code: "BAD_REQUEST", validationIssues: [{ nope: true }] },
      }).validationIssues,
    ).toBeUndefined();
  });

  it("extracts structured transport metadata", () => {
    expect(
      getAppErrorDetails({
        message: "Product no longer exists",
        data: { code: "NOT_FOUND", reason: "PRODUCT_NOT_FOUND" },
      }),
    ).toEqual({
      message: "Product no longer exists",
      code: "NOT_FOUND",
      reason: "PRODUCT_NOT_FOUND",
    });
  });
});

describe("isSupersededViewTransitionError", () => {
  it("matches only the historical Safari transition cancellation", () => {
    expect(
      isSupersededViewTransitionError({
        name: "AbortError",
        message: SUPERSEDED_VIEW_TRANSITION_MESSAGE,
      }),
    ).toBe(true);
    expect(
      isSupersededViewTransitionError(
        new DOMException("Upload aborted", "AbortError"),
      ),
    ).toBe(false);
    expect(
      isSupersededViewTransitionError({
        name: "Error",
        message: SUPERSEDED_VIEW_TRANSITION_MESSAGE,
      }),
    ).toBe(false);
  });
});

describe("isDynamicImportError", () => {
  it.each([
    new TypeError(
      "Failed to fetch dynamically imported module: https://example.test/assets/old.js",
    ),
    new TypeError("Importing a module script failed."),
    new Error("error loading dynamically imported module"),
    new Error("Failed to load module script: Expected JavaScript"),
    new Error("Unable to preload CSS for /assets/old.css"),
    Object.assign(new Error("Loading chunk 8 failed"), {
      name: "ChunkLoadError",
    }),
  ])("recognizes browser deployment-skew failures", (error) => {
    expect(isDynamicImportError(error)).toBe(true);
  });

  it("does not classify an ordinary fetch failure as a stale build", () => {
    expect(isDynamicImportError(new TypeError("Failed to fetch"))).toBe(false);
  });
});
