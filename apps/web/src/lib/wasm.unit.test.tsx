import { parse_ingredient } from "@cubby/recipebridge";
import { describe, expect, it } from "vitest";

import { wasm } from "~/lib/wasm";

/**
 * A `.tsx` on purpose: this has to run under the **ui** (jsdom) project, which
 * is the one that couldn't load the WASM at all until `vitest.config.ts` forced
 * `vite-plugin-wasm` down its base64-inline branch. The node-environment `unit`
 * project already worked and would not catch a regression here.
 *
 * These assert on real parse output rather than mere importability, so the
 * cheap "fix" — aliasing `@cubby/recipebridge` to a stub of empty functions —
 * fails instead of silently turning every ui test that touches WASM into a
 * test of the stub.
 */
describe("WASM under the jsdom test environment", () => {
  it("runs the real module, not a stub", () => {
    const parsed = parse_ingredient("2 cups flour");

    expect(parsed.name).toBe("flour");
    expect(parsed.amounts[0]?.unit).toBe("cup");
    expect(parsed.amounts[0]?.value).toBe(2);
  });

  it("runs the real module through the ~/lib/wasm proxy", () => {
    // The proxy adds tracing + an LRU on top, and is what UI code actually
    // imports — `columnHelpers` reaches WASM through it, via `cell-data`.
    expect(wasm.parse_ingredient("3 tbsp butter").name).toBe("butter");
  });
});
