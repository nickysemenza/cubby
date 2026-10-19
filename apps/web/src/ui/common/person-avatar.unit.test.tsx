import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { avatarToneIndex, PersonAvatar, personInitials } from "./person-avatar";

afterEach(cleanup);

describe("person avatars", () => {
  it("keeps a party's color across renders and independent of its name", () => {
    expect(avatarToneIndex("LPY-ALEX")).toBe(avatarToneIndex("LPY-ALEX"));
    render(
      <>
        <PersonAvatar id="LPY-ALEX" name="Alex" />
        <PersonAvatar id="LPY-ALEX" name="Alex Rivera" />
      </>,
    );
    const [first, renamed] = [
      ...document.querySelectorAll("[data-person-avatar]"),
    ];
    expect(first?.getAttribute("data-person-avatar")).toBe(
      renamed?.getAttribute("data-person-avatar"),
    );
    expect(first).toHaveClass(`bg-category-${avatarToneIndex("LPY-ALEX") + 1}`);
  });

  it("spreads parties over all eight category tones", () => {
    const tones = new Set(
      Array.from({ length: 64 }, (_, index) => avatarToneIndex(`LPY-${index}`)),
    );
    expect(tones.size).toBe(8);
  });

  it("draws two initials, decoratively", () => {
    expect(personInitials("Alex Rivera")).toBe("AR");
    expect(personInitials("Sam")).toBe("SA");
    expect(personInitials("  ")).toBe("?");
    render(<PersonAvatar id="LPY-SAM" name="Sam" />);
    expect(screen.getByText("SA")).toHaveAttribute("aria-hidden", "true");
  });
});
