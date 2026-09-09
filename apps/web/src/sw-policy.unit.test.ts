import { describe, expect, it } from "vitest";

import {
  canReusePrecacheUrl,
  isBypassedPath,
  isCriticalPrecacheUrl,
  shouldFillPrecache,
} from "./sw-policy";

describe("service-worker cache policy", () => {
  it("reuses only content-addressed support assets across deployments", () => {
    for (const url of [
      "/assets/recipebridge_bg-1KzX1Bbg.wasm",
      "/assets/styles-C6yR9jSh.css",
      "/assets/inter-latin-wght-normal-Dx4kXJAl.woff2",
    ])
      expect(canReusePrecacheUrl(url)).toBe(true);
    for (const url of [
      "/offline.html",
      "/icon-192.png",
      "/assets/styles.css",
      "/assets/styles-C6yR9jSh.css?v=old",
      "/assets/app-C6yR9jSh.js",
      "/api/styles-C6yR9jSh.css",
    ])
      expect(canReusePrecacheUrl(url)).toBe(false);
  });
  it.each(["/api", "/api/session"])(
    "never intercepts authenticated endpoint %s",
    (path) => expect(isBypassedPath(path)).toBe(true),
  );

  it("treats the offline page and styles as critical", () => {
    expect(isCriticalPrecacheUrl("/offline.html")).toBe(true);
    expect(isCriticalPrecacheUrl("/assets/app.css")).toBe(true);
    expect(isCriticalPrecacheUrl("/favicon.svg")).toBe(false);
  });

  // The 2.5 MB WASM is precached but must NOT block install — see sw-policy.ts.
  it("does not gate installation on the WASM", () => {
    expect(isCriticalPrecacheUrl("/recipebridge_bg.wasm")).toBe(false);
  });

  it("heals only successful, exact manifest cache misses", () => {
    const manifest = new Set(["/assets/app.css", "/offline.html"]);
    expect(shouldFillPrecache("/assets/app.css", "", true, manifest)).toBe(
      true,
    );
    expect(
      shouldFillPrecache("/assets/app.css", "?v=old", true, manifest),
    ).toBe(false);
    expect(shouldFillPrecache("/assets/app.css", "", false, manifest)).toBe(
      false,
    );
    expect(shouldFillPrecache("/assets/app.js", "", true, manifest)).toBe(
      false,
    );
  });
});
