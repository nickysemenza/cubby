import { describe, expect, it } from "vitest";

import { docSlug, resolveDocHref } from "./doc-paths";

describe("household guide documentation", () => {
  it("keeps guide links in the app and sends repository links to the source", () => {
    expect(docSlug("guides/calendar.md")).toBe("guides--calendar");
    expect(resolveDocHref("terminology.md#core-entities", "burn-down.md")).toBe(
      "/docs/terminology#core-entities",
    );
    // Developer docs outside docs/guide are not bundled into the app.
    expect(resolveDocHref("../agents/validation.md", "burn-down.md")).toBe(
      "https://github.com/nickysemenza/cubby/blob/main/docs/agents/validation.md",
    );
    expect(resolveDocHref("../../README.md", "terminology.md")).toBe(
      "https://github.com/nickysemenza/cubby/blob/main/README.md",
    );
    expect(resolveDocHref("#local-verification", "caldav.md")).toBe(
      "#local-verification",
    );
  });
});
