import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOnFileSince } from "./page-hero";

describe("getOnFileSince", () => {
  const originalTimeZone = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "UTC";
  });

  afterAll(() => {
    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  });

  it("formats created-at instants in the household timezone", () => {
    // Cloudflare renders in UTC while the household browser is in Pacific
    // time. Pinning the zone keeps this text identical during hydration.
    expect(getOnFileSince({ createdAt: "2026-08-25T01:00:00.000Z" })).toBe(
      "Aug 24, 2026",
    );
  });

  it("omits missing or invalid created-at values", () => {
    expect(getOnFileSince({})).toBeNull();
    expect(getOnFileSince({ createdAt: "not-a-date" })).toBeNull();
  });
});
