import { describe, expect, it } from "vitest";

import { mealDisplayName } from "./meal-detail-page";

describe("mealDisplayName", () => {
  it("uses the meal's name when one is present", () => {
    expect(mealDisplayName({ name: "Sunday dinner", date: "2026-08-31" })).toBe(
      "Sunday dinner",
    );
  });

  it("uses a readable date for an unnamed meal", () => {
    expect(mealDisplayName({ name: null, date: "2026-08-31" })).toBe(
      "Mon, Aug 31",
    );
  });
});
