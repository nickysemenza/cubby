import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppFooter } from "./footer";

describe("AppFooter", () => {
  it("links only the displayed commit to its canonical GitHub page", () => {
    render(<AppFooter />);

    expect(screen.getByText("test")).not.toHaveAttribute("href");
    const commitLink = screen.getByRole("link", { name: __SOURCE_COMMIT__ });
    expect(commitLink).toHaveAttribute(
      "href",
      `https://github.com/nickysemenza/cubby/commit/${__SOURCE_COMMIT__}`,
    );
    expect(commitLink).toHaveAttribute("target", "_blank");
    expect(commitLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(commitLink).toHaveAttribute(
      "title",
      `View test@${__SOURCE_COMMIT__} on GitHub`,
    );
  });
});
