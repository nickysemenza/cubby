import { APPLE_CLIENT_COMPATIBILITY_VERSION } from "@cubby/shared/apple-client-version";
import { describe, expect, it } from "vitest";

import { appleClientUpdateRequired } from "./apple-client-gate";

const headers = (userAgent?: string) =>
  new Headers(userAgent === undefined ? {} : { "user-agent": userAgent });
const appUserAgent = (version: string) =>
  `cubby-apple/${version} (ios; 00000000-0000-4000-8000-000000000000)`;

describe("appleClientUpdateRequired", () => {
  it("blocks the native app below the minimum, numerically not lexically", () => {
    expect(appleClientUpdateRequired(headers(appUserAgent("1.0")))).toEqual({
      current: "1.0",
      minimum: APPLE_CLIENT_COMPATIBILITY_VERSION,
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
        headers(appUserAgent(APPLE_CLIENT_COMPATIBILITY_VERSION)),
      ),
    ).toBe(null);
    expect(
      appleClientUpdateRequired(
        headers(
          appUserAgent(
            APPLE_CLIENT_COMPATIBILITY_VERSION.replace(/\d+$/u, (patch) =>
              String(Number(patch) + 1),
            ),
          ),
        ),
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
});
