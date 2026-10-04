import { describe, expect, it } from "vitest";

import {
  retiredFieldworkNotice,
  retiredPhotoPassTarget,
  retiredRecountTarget,
  retiredScanTarget,
} from "./retired-fieldwork";

// Old bookmarks, home-screen shortcuts, and links in notes must land on a
// surviving page instead of a 404 once the web fieldwork surfaces are gone.
describe("retired fieldwork redirects", () => {
  it("sends the recount of one location to that location's page", () => {
    expect(retiredRecountTarget({ parent: "LOC-4K7M" })).toEqual({
      to: "/locations/$shortcode",
      params: { shortcode: "LOC-4K7M" },
      hash: "moved-to-app:recount",
    });
  });

  it("sends a whole-house or worklist recount to the inventory list", () => {
    expect(retiredRecountTarget({})).toEqual({
      to: "/inventory",
      hash: "moved-to-app:recount",
    });
    expect(retiredRecountTarget({ worklist: "shelf-disagrees" })).toEqual({
      to: "/inventory",
      hash: "moved-to-app:recount",
    });
  });

  it("sends a scoped photo pass to the location and an open one to Locations", () => {
    expect(retiredPhotoPassTarget({ parent: "LOC-4K7M" })).toEqual({
      to: "/locations/$shortcode",
      params: { shortcode: "LOC-4K7M" },
      hash: "moved-to-app:photo-pass",
    });
    expect(retiredPhotoPassTarget({})).toEqual({
      to: "/locations",
      hash: "moved-to-app:photo-pass",
    });
  });

  it("sends the scanner to Today", () => {
    expect(retiredScanTarget()).toEqual({
      to: "/",
      hash: "moved-to-app:scan",
    });
  });

  it("ignores a malformed parent rather than 404ing", () => {
    expect(retiredRecountTarget({ parent: "not-a-code" }).to).toBe(
      "/inventory",
    );
  });
});

describe("retiredFieldworkNotice", () => {
  it("names the workflow that moved to the app", () => {
    expect(retiredFieldworkNotice("moved-to-app:scan")).toMatch(/scan/i);
    expect(retiredFieldworkNotice("moved-to-app:recount")).toMatch(/recount/i);
    expect(retiredFieldworkNotice("moved-to-app:photo-pass")).toMatch(
      /photo pass/i,
    );
  });

  it("ignores unrelated hashes", () => {
    expect(retiredFieldworkNotice("")).toBeNull();
    expect(retiredFieldworkNotice("section-2")).toBeNull();
    expect(retiredFieldworkNotice("moved-to-app:other")).toBeNull();
  });
});
