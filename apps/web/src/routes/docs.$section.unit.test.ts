import { describe, expect, it } from "vitest";

import { Route } from "./docs.$section";

describe("documentation section route", () => {
  it("turns unknown document slugs into route not-found recovery", () => {
    const loader = Route.options.loader as unknown as
      | ((args: unknown) => void)
      | undefined;
    if (!loader) throw new Error("expected documentation section loader");

    expect(() => loader({ params: { section: "not-a-document" } })).toThrow(
      expect.objectContaining({ isNotFound: true }),
    );
  });
});
