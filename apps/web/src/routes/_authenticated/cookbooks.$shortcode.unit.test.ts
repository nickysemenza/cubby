import { describe, expect, it, vi } from "vitest";

import { cookbook } from "~/entities/cookbook.functions";

import { Route } from "./cookbooks.$shortcode";

describe("cookbook detail loader", () => {
  it("preloads the focused detail and turns an unknown code into router not-found", async () => {
    const ensureQueryData = vi
      .fn()
      .mockResolvedValueOnce({ id: "CKB-ALPHA", book: "Alpha" })
      .mockResolvedValueOnce(null);
    const loader = Route.options.loader as unknown as
      | ((args: unknown) => Promise<void>)
      | undefined;
    if (!loader) throw new Error("expected cookbook detail loader");
    const context = { queryClient: { ensureQueryData } };

    await loader({ params: { shortcode: "CKB-ALPHA" }, context } as never);
    expect(ensureQueryData).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: cookbook.detail.queryKey({ shortcode: "CKB-ALPHA" }),
      }),
    );

    await expect(
      loader({ params: { shortcode: "CKB-MISSING" }, context } as never),
    ).rejects.toMatchObject({ isNotFound: true });
  });
});
