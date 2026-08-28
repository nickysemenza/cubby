import { describe, expect, it, vi } from "vitest";

import {
  loadCookbookDetail,
  type CookbookDetailLoaderPort,
} from "./cookbooks.$shortcode";

describe("cookbook detail loader", () => {
  it("preloads the focused detail and turns an unknown code into router not-found", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ id: "CKB-ALPHA", book: "Alpha" })
      .mockResolvedValueOnce(null);
    const port: CookbookDetailLoaderPort = { load };

    await loadCookbookDetail("CKB-ALPHA", port);
    expect(load).toHaveBeenCalledWith("CKB-ALPHA");

    await expect(loadCookbookDetail("CKB-MISSING", port)).rejects.toMatchObject(
      { isNotFound: true },
    );
  });
});
