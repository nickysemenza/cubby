import { describe, expect, it } from "vitest";
import { auditLogListOut } from "./audit";
import {
  APPLICATION_AUDIT_SOURCES,
  auditSourceSchema,
  isScriptAuditSource,
} from "./context";

/**
 * Regression guard for the closed-enum outage: 567 `AuditLog` rows written by
 * out-of-band maintenance scripts on 2026-07-28 carried sources outside
 * `auditSourceSchema`, so `auditLog.list` failed *output* validation and the
 * activity feed / home page rendered an error instead of content.
 *
 * The failure mode that matters is the second describe block: one unparseable
 * row rejects the whole `entries` array, so a single stray source takes out
 * every entry on the page — not just its own.
 */
describe("auditSourceSchema", () => {
  it.each([...APPLICATION_AUDIT_SOURCES])("accepts %s", (source) => {
    expect(auditSourceSchema.parse(source)).toBe(source);
  });

  it.each([
    "script:vendor-normalization-2026-07-28",
    "script:url-cleanup-2026-07-28",
    "script:home-depot-export-2026-07-28",
    "script:vendor-from-name-2026-07-28",
  ])("accepts the real out-of-band source %s", (source) => {
    expect(auditSourceSchema.parse(source)).toBe(source);
  });

  it.each([
    // A bare prefix carries no provenance, which is the whole point of allowing it.
    "script:",
    "",
    "ui ",
    "nonsense",
    "SCRIPT:shouting",
  ])("rejects %o", (source) => {
    expect(auditSourceSchema.safeParse(source).success).toBe(false);
  });

  it("narrows script sources without swallowing application ones", () => {
    expect(isScriptAuditSource("script:whatever")).toBe(true);
    expect(isScriptAuditSource("ui")).toBe(false);
  });
});

const entry = (source: string) => ({
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  entityType: "product" as const,
  entityId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
  action: "update" as const,
  changes: { tags: { from: [], to: ["fs-rail"] } },
  userId: "user-1",
  source,
  createdAt: new Date("2026-07-28T00:00:00Z"),
  user: null,
});

describe("auditLogListOut", () => {
  it("parses an entry whose source came from a script", () => {
    const parsed = auditLogListOut.parse({
      entries: [entry("script:home-depot-export-2026-07-28")],
    });
    expect(parsed.entries[0]?.source).toBe(
      "script:home-depot-export-2026-07-28",
    );
  });

  it("keeps every sibling entry when a script source is present", () => {
    // The original bug: this array is what `auditLog.list` returns, and one
    // rejected row failed the entire response.
    const parsed = auditLogListOut.parse({
      entries: [
        entry("ui"),
        entry("script:url-cleanup-2026-07-28"),
        entry("sheets_import"),
      ],
    });
    expect(parsed.entries).toHaveLength(3);
  });
});
