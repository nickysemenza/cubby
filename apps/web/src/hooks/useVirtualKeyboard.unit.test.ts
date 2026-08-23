import { describe, expect, it } from "vitest";
import { detectSoftwareKeyboard } from "./useVirtualKeyboard";

describe("detectSoftwareKeyboard", () => {
  it("detects a materially occluded phone viewport", () => {
    expect(detectSoftwareKeyboard(844, 470)).toBe(true);
  });

  it("ignores browser toolbar and small viewport changes", () => {
    expect(detectSoftwareKeyboard(844, 760)).toBe(false);
    expect(detectSoftwareKeyboard(568, 500, 8)).toBe(false);
  });
});
