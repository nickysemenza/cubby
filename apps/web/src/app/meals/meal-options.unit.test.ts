import {
  mealKindValues,
  mealTypeValues,
} from "@cubby/schemas/meal-classification";
import { describe, expect, it } from "vitest";

import { mealKindIcon, mealTypeIcon, mealTypeTimeLabel } from "./meal-options";

describe("meal glyphs", () => {
  it("gives every slot its own icon", () => {
    const icons = mealTypeValues.map((v) => mealTypeIcon(v));
    // Distinct: two slots sharing a glyph would make the calendar unreadable
    // in exactly the case the icon exists for — several meals on one day.
    expect(new Set(icons).size).toBe(mealTypeValues.length);
    expect(icons.every(Boolean)).toBe(true);
  });

  it("falls back to a generic glyph when unslotted", () => {
    const unslotted = mealTypeIcon(null);
    expect(unslotted).toBeTruthy();
    // Not one of the slot glyphs, or an unslotted meal would read as a slotted one.
    expect(mealTypeValues.map((v) => mealTypeIcon(v))).not.toContain(unslotted);
  });

  it("distinguishes leftovers from the generic unslotted meal", () => {
    expect(mealKindIcon("leftovers")).not.toBe(mealTypeIcon(null));
  });

  it("marks only the non-cooked kinds", () => {
    // `cooked` is nearly every meal; a glyph on all of them would distinguish
    // nothing. Same rule as the badge tone and the ICS description.
    expect(mealKindIcon("cooked")).toBeNull();
    for (const kind of mealKindValues.filter((k) => k !== "cooked")) {
      expect(mealKindIcon(kind)).toBeTruthy();
    }
  });
});

describe("meal slot time labels", () => {
  it("labels each slot with its canonical hour", () => {
    expect(mealTypeTimeLabel("breakfast")).toBe("9:00 AM");
    expect(mealTypeTimeLabel("lunch")).toBe("12:00 PM");
    expect(mealTypeTimeLabel("dinner")).toBe("7:00 PM");
  });

  it("has no time for an unslotted meal", () => {
    // The time comes from the slot, so no slot means no time to show — the
    // same rule the ICS feed applies when it leaves these events all-day.
    expect(mealTypeTimeLabel(null)).toBeNull();
  });
});
