import { describe, expect, it } from "vitest";
import {
  decodeAuditCursor,
  diffUnorderedIdSet,
  encodeAuditCursor,
} from "~/server/repo/audit-log";

describe("audit cursor", () => {
  it("round-trips an opaque timestamp + id cursor", () => {
    const createdAt = new Date("2026-08-01T12:34:56.789Z");
    const cursor = encodeAuditCursor({ createdAt, id: "private-row-id" });

    expect(cursor).not.toContain(createdAt.toISOString());
    expect(decodeAuditCursor(cursor)).toEqual({
      createdAt,
      id: "private-row-id",
    });
  });

  it("continues accepting the legacy ISO timestamp cursor", () => {
    const iso = "2026-08-01T12:34:56.789Z";
    expect(decodeAuditCursor(iso)).toEqual({ createdAt: new Date(iso) });
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeAuditCursor("v1.not-base64-json")).toThrow(
      "Invalid audit log cursor",
    );
  });
});

describe("diffUnorderedIdSet", () => {
  it("returns undefined when the sets are equal but reordered", () => {
    const result = diffUnorderedIdSet(["a", "b", "c"], ["c", "a", "b"]);
    expect(result).toBeUndefined();
  });

  it("returns undefined when both sets are empty", () => {
    const result = diffUnorderedIdSet([], []);
    expect(result).toBeUndefined();
  });

  it("detects an added id", () => {
    const result = diffUnorderedIdSet(["a"], ["a", "b"]);
    expect(result).toEqual({ from: ["a"], to: ["a", "b"] });
  });

  it("detects a removed id", () => {
    const result = diffUnorderedIdSet(["a", "b"], ["a"]);
    expect(result).toEqual({ from: ["a", "b"], to: ["a"] });
  });

  it("preserves the original (unsorted) order in the returned from/to", () => {
    const result = diffUnorderedIdSet(["b", "a"], ["a", "b", "c"]);
    expect(result).toEqual({ from: ["b", "a"], to: ["a", "b", "c"] });
  });
});
