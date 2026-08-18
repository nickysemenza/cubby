import { afterEach, describe, expect, it } from "vitest";
import type { CopiedGrid } from "./cell-clipboard-model";
import {
  bufferMatches,
  clearCopyBuffer,
  getCopyBuffer,
  setCopyBuffer,
} from "./cell-copy-buffer";

afterEach(() => {
  clearCopyBuffer();
});

describe("getCopyBuffer / setCopyBuffer", () => {
  it("returns null before anything is set", () => {
    expect(getCopyBuffer()).toBeNull();
  });

  it("returns the grid and tsv that were set", () => {
    const grid: CopiedGrid = [[{ kind: "text", text: "a", json: "a" }]];
    setCopyBuffer(grid, "a");

    expect(getCopyBuffer()).toEqual({ grid, tsv: "a" });
  });

  it("overwrites a previous buffer on a subsequent set", () => {
    const gridA: CopiedGrid = [[{ kind: "text", text: "a", json: "a" }]];
    const gridB: CopiedGrid = [[{ kind: "text", text: "b", json: "b" }]];
    setCopyBuffer(gridA, "a");
    setCopyBuffer(gridB, "b");

    expect(getCopyBuffer()).toEqual({ grid: gridB, tsv: "b" });
  });
});

describe("bufferMatches", () => {
  it("returns false when the buffer is empty", () => {
    expect(bufferMatches("a")).toBe(false);
  });

  it("returns true for an exact match", () => {
    setCopyBuffer([[{ kind: "text", text: "a", json: "a" }]], "a\tb");
    expect(bufferMatches("a\tb")).toBe(true);
  });

  it("returns true when clipboard text has trailing whitespace/newlines the buffer doesn't", () => {
    setCopyBuffer([[{ kind: "text", text: "a", json: "a" }]], "a\tb");
    expect(bufferMatches("a\tb\n")).toBe(true);
    expect(bufferMatches("a\tb\n\n  ")).toBe(true);
  });

  it("returns true when the buffer has trailing whitespace the clipboard text doesn't", () => {
    setCopyBuffer([[{ kind: "text", text: "a", json: "a" }]], "a\tb\n");
    expect(bufferMatches("a\tb")).toBe(true);
  });

  it("returns false for a genuine mismatch", () => {
    setCopyBuffer([[{ kind: "text", text: "a", json: "a" }]], "a\tb");
    expect(bufferMatches("c\td")).toBe(false);
  });

  it("returns false after the buffer is cleared", () => {
    setCopyBuffer([[{ kind: "text", text: "a", json: "a" }]], "a\tb");
    clearCopyBuffer();
    expect(bufferMatches("a\tb")).toBe(false);
  });
});
