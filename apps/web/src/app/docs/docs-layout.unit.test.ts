import { describe, expect, it } from "vitest";
import { DOCS_NAV_LINK_CLASS } from "./docs-layout";

describe("documentation navigation", () => {
  it("keeps compact desktop links while reserving a 44px phone target", () => {
    expect(DOCS_NAV_LINK_CLASS).toContain("text-sm");
    expect(DOCS_NAV_LINK_CLASS).toContain("max-md:min-h-11");
    expect(DOCS_NAV_LINK_CLASS).toContain("max-md:items-center");
  });
});
