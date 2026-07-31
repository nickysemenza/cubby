import { describe, expect, it } from "vitest";
import { auditLogListInput, auditLogListOut } from "./audit";
import {
  APPLICATION_AUDIT_SOURCES,
  auditSourceSchema,
  isScriptAuditSource,
} from "./context";
import { oneOrMany } from "./pagination";

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

/**
 * `auditLogListInput.source` (PR 6, Phase 6) reuses `auditSourceSchema`
 * through `oneOrMany` rather than narrowing it — a closed enum on the filter
 * would reintroduce the exact outage this file's first describe block guards
 * against, just on the read side of a query param instead of the DB column.
 */
describe("oneOrMany(auditSourceSchema)", () => {
  const sourceFilter = oneOrMany(auditSourceSchema);

  it.each([...APPLICATION_AUDIT_SOURCES])(
    "accepts a bare APPLICATION_AUDIT_SOURCES value: %s",
    (source) => {
      expect(sourceFilter.parse(source)).toBe(source);
    },
  );

  it("accepts a bare script: value", () => {
    expect(sourceFilter.parse("script:home-depot-export-2026-07-28")).toBe(
      "script:home-depot-export-2026-07-28",
    );
  });

  it("accepts an array mixing application and script sources", () => {
    const value = ["ui", "script:url-cleanup-2026-07-28", "api"];
    expect(sourceFilter.parse(value)).toEqual(value);
  });

  it.each(["script:", "", "nonsense", "SCRIPT:shouting"])(
    "rejects %o whether bare or inside an array",
    (bad) => {
      expect(sourceFilter.safeParse(bad).success).toBe(false);
      expect(sourceFilter.safeParse([bad]).success).toBe(false);
    },
  );

  it("is exactly what auditLogListInput.source accepts", () => {
    // auditLogListInput must not narrow the filter beyond oneOrMany(auditSourceSchema).
    expect(
      auditLogListInput.shape.source.parse(
        "script:vendor-normalization-2026-07-28",
      ),
    ).toBe("script:vendor-normalization-2026-07-28");
    expect(
      auditLogListInput.shape.source.parse(["ui", "sheets_import"]),
    ).toEqual(["ui", "sheets_import"]);
  });
});

describe("auditLogListInput window filters", () => {
  it("accepts public entity shortcodes and rejects UUID filters", () => {
    expect(
      auditLogListInput.safeParse({
        entityType: "product",
        entityId: "PRD-2CRC",
      }).success,
    ).toBe(true);
    expect(
      auditLogListInput.safeParse({
        entityType: "product",
        entityId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
      }).success,
    ).toBe(false);
  });

  it("accepts createdAtFrom/createdAtTo as plain ISO strings", () => {
    const parsed = auditLogListInput.parse({
      limit: 50,
      createdAtFrom: "2026-07-01T00:00:00.000Z",
      createdAtTo: "2026-07-31T23:59:59.999Z",
    });
    expect(parsed.createdAtFrom).toBe("2026-07-01T00:00:00.000Z");
    expect(parsed.createdAtTo).toBe("2026-07-31T23:59:59.999Z");
  });

  it("leaves createdAtFrom/createdAtTo/source optional", () => {
    const parsed = auditLogListInput.parse({ limit: 50 });
    expect(parsed.createdAtFrom).toBeUndefined();
    expect(parsed.createdAtTo).toBeUndefined();
    expect(parsed.source).toBeUndefined();
  });
});

const entry = (source: string) => ({
  entityType: "product" as const,
  entityId: "PRD-2CRC",
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
