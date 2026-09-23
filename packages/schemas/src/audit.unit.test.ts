import { describe, expect, it } from "vitest";
import { auditLogListInput, auditLogListOut } from "./audit";
import { AUDIT_CHANNELS } from "./context";

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

  it("leaves createdAtFrom/createdAtTo/channel optional", () => {
    const parsed = auditLogListInput.parse({ limit: 50 });
    expect(parsed.createdAtFrom).toBeUndefined();
    expect(parsed.createdAtTo).toBeUndefined();
    expect(parsed.channel).toBeUndefined();
  });
});

const entry = (channel: string) => ({
  entryKey: `test:${channel}`,
  entityType: "product" as const,
  entityId: "PRD-2CRC",
  canonicalEntityId: null,
  entityName: "Track Saw Rail",
  displayImage: null,
  action: "update" as const,
  changes: { tags: { from: [], to: ["fs-rail"] } },
  userId: "user-1",
  channel,
  oauthClient: null,
  device: null,
  runId: null,
  createdAt: new Date("2026-07-28T00:00:00Z"),
  user: null,
});

/**
 * Regression guard for the audit-feed outage: one row whose provenance value
 * the read schema rejected failed the whole `entries` array, so the activity
 * feed and home page rendered an error. `AuditLog_channel_check` now keeps the
 * column inside `AUDIT_CHANNELS`, and the read schema must accept every value
 * that constraint admits.
 */
describe("auditLogListOut", () => {
  it("parses a page holding every channel the database admits", () => {
    const parsed = auditLogListOut.parse({
      entries: AUDIT_CHANNELS.map(entry),
    });
    expect(parsed.entries.map((row) => row.channel)).toEqual([
      ...AUDIT_CHANNELS,
    ]);
  });
});
