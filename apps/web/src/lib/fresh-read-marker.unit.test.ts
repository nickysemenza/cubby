import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRESH_READ_COOKIE_NAME,
  hasFreshReadMarker,
  markFreshReads,
} from "./fresh-read-marker";

describe("fresh-read marker", () => {
  let assignments: string[];

  beforeEach(() => {
    assignments = [];
    const documentStub = {};
    Object.defineProperty(documentStub, "cookie", {
      configurable: true,
      get: () => assignments.at(-1) ?? "",
      set: (value: string) => assignments.push(value),
    });
    vi.stubGlobal("document", documentStub);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("writes the HTTPS marker with the required attributes", () => {
    vi.stubGlobal("location", { protocol: "https:" });

    markFreshReads();

    expect(assignments).toEqual([
      `${FRESH_READ_COOKIE_NAME}=1; Max-Age=20; Path=/; SameSite=Lax; Secure`,
    ]);
  });

  it("omits Secure for local HTTP previews", () => {
    vi.stubGlobal("location", { protocol: "http:" });

    markFreshReads();

    expect(assignments[0]).toBe(
      `${FRESH_READ_COOKIE_NAME}=1; Max-Age=20; Path=/; SameSite=Lax`,
    );
  });

  it("is a no-op when called without a document", () => {
    vi.unstubAllGlobals();

    expect(() => markFreshReads()).not.toThrow();
  });

  it("recognizes only an exact marker cookie value", () => {
    expect(
      hasFreshReadMarker(
        new Headers({ cookie: "session=abc; cubby-fresh-reads=1" }),
      ),
    ).toBe(true);
    expect(
      hasFreshReadMarker(new Headers({ cookie: "cubby-fresh-reads=0" })),
    ).toBe(false);
    expect(hasFreshReadMarker(new Headers())).toBe(false);
  });
});
