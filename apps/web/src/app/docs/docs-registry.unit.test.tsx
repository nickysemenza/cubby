import { describe, expect, it } from "vitest";

import { docSlug, resolveDocHref } from "./doc-paths";

describe("repository documentation", () => {
  it("keeps docs links in the app and sends repository links to the source", () => {
    expect(docSlug("agents/validation.md")).toBe("agents--validation");
    expect(
      resolveDocHref("../terminology.md#core-entities", "agents/web-ui.md"),
    ).toBe("/docs/terminology#core-entities");
    expect(resolveDocHref("agents/validation.md", "ci.md")).toBe(
      "/docs/agents--validation",
    );
    expect(resolveDocHref("../README.md", "inventory-audit.md")).toBe(
      "https://github.com/nickysemenza/cubby/blob/main/README.md",
    );
    expect(resolveDocHref("#local-verification", "ci.md")).toBe(
      "#local-verification",
    );
  });
});
