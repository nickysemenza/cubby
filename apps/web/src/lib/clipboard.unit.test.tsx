import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

import { copyShortcodes, copyText } from "./clipboard";

/** Point `navigator.clipboard.writeText` at a stub for one test. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("copyText", () => {
  it("uses the async clipboard when it resolves", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const execCommand = vi.fn();
    document.execCommand = execCommand;

    await expect(copyText("PRD-4K7M")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("PRD-4K7M");
    expect(execCommand).not.toHaveBeenCalled();
  });

  // iOS Safari rejects `writeText` outside a trusted gesture — an expected
  // path, not an anomaly, so the legacy ladder has to carry it.
  it("falls back to execCommand when the clipboard API rejects", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    let staged = "";
    document.execCommand = vi.fn(() => {
      staged = document.querySelector("textarea")?.value ?? "";
      return true;
    });

    await expect(copyText("LOC-9X2A")).resolves.toBe(true);
    expect(staged).toBe("LOC-9X2A");
    // The scratch textarea must not survive the copy.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when both paths fail", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    document.execCommand = vi.fn(() => false);

    await expect(copyText("PRD-4K7M")).resolves.toBe(false);
  });
});

describe("copyShortcodes", () => {
  it("joins codes one per line and names the count", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    await expect(
      copyShortcodes(["PRD-4K7M", "PRD-9X2A", "PRD-1B3C"]),
    ).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("PRD-4K7M\nPRD-9X2A\nPRD-1B3C");
    expect(mocks.success).toHaveBeenCalledWith("Copied 3 codes");
  });

  it("names the code itself when there is only one", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));

    await expect(copyShortcodes(["PRD-4K7M"])).resolves.toBe(true);
    expect(mocks.success).toHaveBeenCalledWith("Copied PRD-4K7M");
  });

  it("toasts an error and reports failure when the copy does not land", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    document.execCommand = vi.fn(() => false);

    await expect(copyShortcodes(["PRD-4K7M"])).resolves.toBe(false);
    expect(mocks.error).toHaveBeenCalledWith("Copy failed");
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("is a no-op on an empty selection", async () => {
    const writeText = vi.fn();
    stubClipboard(writeText);

    await expect(copyShortcodes([])).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
