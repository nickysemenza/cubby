import { describe, expect, it } from "vitest";
import { isBypassedPath, isCriticalPrecacheUrl } from "./sw-policy";

describe("service-worker cache policy", () => {
  it.each(["/api", "/api/session", "/trpc", "/trpc/recipe.list"])(
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
});
