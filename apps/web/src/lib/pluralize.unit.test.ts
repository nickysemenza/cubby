import { describe, expect, it } from "vitest";

import { countLabel } from "./pluralize";

describe("countLabel", () => {
  it("formats a count with the correct irregular plural", () => {
    expect(countLabel(1_240, "child", { formatted: true })).toBe(
      "1,240 children",
    );
  });
});
