import { describe, expect, it } from "vitest";
import { isBypassedPath, isCriticalPrecacheUrl } from "./sw-policy";

describe("service-worker cache policy", () => {
  it.each(["/api", "/api/session", "/trpc", "/trpc/recipe.list"])(
    "never intercepts authenticated endpoint %s",
    (path) => expect(isBypassedPath(path)).toBe(true),
  );

  it("treats the offline page, styles, and WASM as critical", () => {
    expect(isCriticalPrecacheUrl("/offline.html")).toBe(true);
    expect(isCriticalPrecacheUrl("/assets/app.css")).toBe(true);
    expect(isCriticalPrecacheUrl("/recipebridge_bg.wasm")).toBe(true);
    expect(isCriticalPrecacheUrl("/favicon.svg")).toBe(false);
  });
});
