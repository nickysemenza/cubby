import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appleClientUpdateRequired,
  MINIMUM_APPLE_CLIENT_VERSION,
} from "./apple-client-gate";

const headers = (userAgent?: string) =>
  new Headers(userAgent === undefined ? {} : { "user-agent": userAgent });
const appUserAgent = (version: string) =>
  `cubby-apple/${version} (ios; 00000000-0000-4000-8000-000000000000)`;

describe("appleClientUpdateRequired", () => {
  it("blocks the native app below the minimum, numerically not lexically", () => {
    expect(appleClientUpdateRequired(headers(appUserAgent("1.0")))).toEqual({
      current: "1.0",
      minimum: MINIMUM_APPLE_CLIENT_VERSION,
    });
    expect(appleClientUpdateRequired(headers(appUserAgent("1.9.12")))).not.toBe(
      null,
    );
    // `10.0` sorts before `2.0` as text; it is the newer build.
    expect(appleClientUpdateRequired(headers(appUserAgent("10.0")))).toBe(null);
  });

  it("admits the minimum and anything newer", () => {
    expect(
      appleClientUpdateRequired(
        headers(appUserAgent(MINIMUM_APPLE_CLIENT_VERSION)),
      ),
    ).toBe(null);
    expect(
      appleClientUpdateRequired(
        headers(appUserAgent(`${MINIMUM_APPLE_CLIENT_VERSION}.1`)),
      ),
    ).toBe(null);
  });

  it("never gates other callers or unreadable versions", () => {
    for (const userAgent of [
      undefined,
      "Mozilla/5.0",
      "cubby-cli/unknown (macos; none)",
      "cubby-unknown/0 (ios; none)",
      "cubby-apple/unknown (ios; none)",
      "cubby-apple (ios; none)",
    ])
      expect(appleClientUpdateRequired(headers(userAgent))).toBe(null);
  });

  it("is satisfied by the marketing version this checkout ships", () => {
    // A minimum above the shipped MARKETING_VERSION would lock out the very
    // TestFlight build that carries the new wire shapes.
    const project = readFileSync(
      resolve(import.meta.dirname, "../../../apple/project.yml"),
      "utf8",
    );
    const shipped = /^\s*MARKETING_VERSION:\s*"([^"]+)"/mu.exec(project)?.[1];
    expect(shipped).toBeDefined();
    expect(
      appleClientUpdateRequired(headers(appUserAgent(shipped ?? "0"))),
    ).toBe(null);
  });
});
