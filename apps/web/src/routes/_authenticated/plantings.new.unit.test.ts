import { describe, expect, it } from "vitest";

import { Route } from "./plantings.new";

describe("/plantings/new", () => {
  it("replaces the retired detail-shaped URL with the create-dialog deep link", () => {
    // SAFETY: The redirect runs before reading route context, so an empty value
    // exercises the complete callback without fabricating unused router state.
    expect(() => Route.options.beforeLoad?.({} as never)).toThrow(
      expect.objectContaining({
        options: expect.objectContaining({
          to: "/plantings",
          search: { create: true },
          replace: true,
        }),
      }),
    );
  });
});
