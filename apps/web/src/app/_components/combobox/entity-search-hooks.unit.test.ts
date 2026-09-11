import { describe, expect, it } from "vitest";

import { resolveBlankFilterKey } from "./entity-search-hooks";

describe("resolveBlankFilterKey", () => {
  it("resolves ingredient's name filter to nameFilter", () => {
    // ingredient's `name` column filter descriptor declares `field: "nameFilter"`
    // (see entity-filter-bindings.gen.ts) — the blank-query list request keys
    // on that field, not a hand-listed default.
    expect(resolveBlankFilterKey("ingredient")).toBe("nameFilter");
  });

  it("resolves task's name filter to search", () => {
    // task's `name` column filter descriptor declares `field: "search"` — the
    // one place the manifest-resolved key diverges from `nameFilter`.
    expect(resolveBlankFilterKey("task")).toBe("search");
  });

  it("resolves recipe, location, and product to nameFilter, project to search", () => {
    expect(resolveBlankFilterKey("recipe")).toBe("nameFilter");
    expect(resolveBlankFilterKey("location")).toBe("nameFilter");
    expect(resolveBlankFilterKey("product")).toBe("nameFilter");
    expect(resolveBlankFilterKey("project")).toBe("search");
  });
});
