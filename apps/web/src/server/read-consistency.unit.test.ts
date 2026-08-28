import { describe, expect, it } from "vitest";

import { decideReadConsistency, isBrowserUiRequest } from "./read-consistency";

const request = (options?: {
  browserRequest?: boolean;
  boundedStaleAvailable?: boolean;
  cookie?: string;
}) =>
  decideReadConsistency({
    browserRequest: options?.browserRequest ?? true,
    boundedStaleAvailable: options?.boundedStaleAvailable ?? true,
    headers: new Headers(options?.cookie ? { cookie: options.cookie } : {}),
  });

describe("read consistency", () => {
  it("recognizes only browser transport and navigation requests", () => {
    expect(
      isBrowserUiRequest(new Headers({ "sec-fetch-site": "same-origin" })),
    ).toBe(true);
    expect(
      isBrowserUiRequest(new Headers({ "sec-fetch-mode": "navigate" })),
    ).toBe(true);
    expect(isBrowserUiRequest(new Headers())).toBe(false);
  });

  it("selects bounded-stale reads only for an ordinary browser request", () => {
    expect(request()).toEqual({
      consistency: "bounded-stale",
      reason: "cached-policy",
    });
  });

  it("forces fresh reads during the post-mutation window", () => {
    expect(request({ cookie: "session=abc; cubby-fresh-reads=1" })).toEqual({
      consistency: "strong",
      reason: "fresh-after-write",
    });
  });

  it("keeps non-browser callers strong", () => {
    expect(request({ browserRequest: false })).toEqual({
      consistency: "strong",
      reason: "non-browser-origin",
    });
  });

  it("aliases reads to strong when only one database adapter exists", () => {
    expect(request({ boundedStaleAvailable: false })).toEqual({
      consistency: "strong",
      reason: "single-database",
    });
  });
});
