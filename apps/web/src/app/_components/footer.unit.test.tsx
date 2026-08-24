import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppFooter } from "./footer";

describe("AppFooter", () => {
  it("links only the displayed commit to its canonical GitHub page", () => {
    render(
      <AppFooter
        buildDate="24 AUG 2026"
        provenance={{
          branch: "main",
          commit: "f8d6c22",
          commitUrl:
            "https://github.com/nickysemenza/cubby/commit/f8d6c22e0c1571fe1f3951b58324824451364b23",
        }}
      />,
    );

    expect(screen.getByText("main")).not.toHaveAttribute("href");
    const commitLink = screen.getByRole("link", { name: "f8d6c22" });
    expect(commitLink).toHaveAttribute(
      "href",
      "https://github.com/nickysemenza/cubby/commit/f8d6c22e0c1571fe1f3951b58324824451364b23",
    );
    expect(commitLink).toHaveAttribute("target", "_blank");
    expect(commitLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(commitLink).toHaveAttribute("title", "View main@f8d6c22 on GitHub");
  });
});
