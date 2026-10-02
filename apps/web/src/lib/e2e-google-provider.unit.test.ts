import { describe, expect, it } from "vitest";

import { localGoogleProviderOrigin } from "./e2e-google-provider";

// A local identity provider must never replace Google in ordinary runtime or
// allow the fixture token/JWKS seam to redirect credentials off loopback.
describe("local Google provider boundary", () => {
  it("requires explicit E2E mode and a loopback HTTP origin", () => {
    expect(
      localGoogleProviderOrigin("false", "http://127.0.0.1:1234"),
    ).toBeUndefined();
    expect(localGoogleProviderOrigin("true", undefined)).toBeUndefined();
    expect(localGoogleProviderOrigin("true", "http://127.0.0.1:1234")).toBe(
      "http://127.0.0.1:1234",
    );
    for (const value of [
      "https://example.test",
      "http://user:secret@localhost:1234",
      "http://localhost:1234/override",
      "file:///tmp/provider",
    ])
      expect(() => localGoogleProviderOrigin("true", value)).toThrow(
        "E2E Google provider must be a loopback HTTP origin",
      );
  });
});
