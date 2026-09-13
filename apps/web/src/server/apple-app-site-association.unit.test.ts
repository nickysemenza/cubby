import { LEGACY_SHORTCODE_PREFIX, SHORTCODE_PREFIX } from "@cubby/shared";
import { describe, expect, it } from "vitest";

import {
  buildAppleAppSiteAssociation,
  GET,
} from "./apple-app-site-association";

describe("buildAppleAppSiteAssociation", () => {
  const doc = buildAppleAppSiteAssociation();
  const detail = doc.applinks.details[0];
  const paths = detail?.components.map((component) => component["/"]) ?? [];

  it("carries the Cubby team/bundle app id", () => {
    expect(detail?.appIDs).toEqual(["Y9A97FXT63.com.nickysemenza.cubby"]);
  });

  it("emits one bare component per canonical shortcode prefix", () => {
    for (const prefix of Object.values(SHORTCODE_PREFIX)) {
      expect(paths).toContain(`/${prefix}????`);
    }
  });

  it("emits one bare component per legacy shortcode prefix", () => {
    for (const prefix of Object.keys(LEGACY_SHORTCODE_PREFIX)) {
      expect(paths).toContain(`/${prefix}????`);
    }
  });

  // Every other web URL must keep opening in Safari, not the native app.
  it("never emits a catch-all component", () => {
    for (const path of paths) {
      expect(path).not.toBe("/*");
      expect(path.includes("*")).toBe(false);
    }
  });

  it("emits exactly one component per canonical and legacy prefix, no more", () => {
    const expectedCount =
      Object.keys(SHORTCODE_PREFIX).length +
      Object.keys(LEGACY_SHORTCODE_PREFIX).length;
    // detailRouteComponents adds further, non-bare components on top of these;
    // assert the bare-prefix ones are present as a subset rather than pinning
    // the total, which would break every time a web detail route is added.
    const barePaths = paths.filter((path) => /^\/[A-Z]+-\?{4}$/.test(path));
    expect(barePaths).toHaveLength(expectedCount);
  });
});

describe("GET /.well-known/apple-app-site-association", () => {
  it("serves the document as application/json", async () => {
    const response = GET();

    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(await response.json()).toEqual(buildAppleAppSiteAssociation());
  });
});
