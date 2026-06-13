import { describe, expect, it } from "vitest";
import { diffWords } from "./inline-text-diff.logic";

// Collapse segments back to the two source strings to prove the diff is lossless.
const reconstruct = (segs: { type: string; text: string }[]) => ({
  before: segs
    .filter((s) => s.type !== "add")
    .map((s) => s.text)
    .join(""),
  after: segs
    .filter((s) => s.type !== "remove")
    .map((s) => s.text)
    .join(""),
});

describe("diffWords", () => {
  it("marks a pure append as added at the end", () => {
    const segs = diffWords("packed", "packed, fresh");
    expect(segs[0]).toEqual({ type: "common", text: "packed" });
    expect(segs.some((s) => s.type === "add" && s.text.includes("fresh"))).toBe(
      true,
    );
    expect(segs.some((s) => s.type === "remove")).toBe(false);
  });

  it("treats an empty before as all added", () => {
    const segs = diffWords("", "fresh");
    expect(segs).toEqual([{ type: "add", text: "fresh" }]);
  });

  it("emits no segments and no diff for identical text", () => {
    const segs = diffWords("peeled", "peeled");
    expect(segs).toEqual([{ type: "common", text: "peeled" }]);
  });

  it("is lossless — segments reconstruct both inputs", () => {
    const before = "peeled, or large garlic clove";
    const after = "medium or large, peeled";
    const { before: b, after: a } = reconstruct(diffWords(before, after));
    expect(b).toBe(before);
    expect(a).toBe(after);
  });
});
