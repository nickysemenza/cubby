import { describe, expect, it } from "vitest";

import { selfLinkLabel } from "./link-label";

describe("selfLinkLabel", () => {
  it("shortens an exact self-link to host + path", () => {
    const url = "https://www.amazon.com/dp/B00JWFIKOC";
    expect(selfLinkLabel(url, url)).toBe("amazon.com/dp/B00JWFIKOC");
  });

  it("treats a trailing slash as the same link", () => {
    expect(
      selfLinkLabel("https://example.com/foo/", "https://example.com/foo"),
    ).toBe("example.com/foo");
  });

  it("strips the www. prefix from the host", () => {
    const url = "https://www.homedepot.com/order";
    expect(selfLinkLabel(url, url)).toBe("homedepot.com/order");
  });

  it("truncates a long path with an ellipsis", () => {
    const url = "https://example.com/this/is/a/really/long/path/segment";
    const label = selfLinkLabel(url, url);
    expect(label).not.toBeNull();
    expect(label).toContain("…");
    // host + at most 24 chars of path
    expect((label ?? "").length).toBeLessThanOrEqual("example.com".length + 24);
  });

  it("returns null when the text is not the same as the href", () => {
    expect(selfLinkLabel("https://example.com/foo", "Click here")).toBeNull();
  });

  it("returns null for an unparseable href", () => {
    expect(selfLinkLabel("not a url", "not a url")).toBeNull();
  });
});
