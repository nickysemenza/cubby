import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppFooter } from "./footer";

const metadata = {
  date: "2026-01-02T00:30:00Z",
  branch: "example-branch",
  commit: "abc1234",
};

describe("AppFooter", () => {
  it("links only the displayed commit to its canonical GitHub page", () => {
    render(<AppFooter metadata={metadata} />);
    expect(screen.getByTestId("build-metadata")).toHaveTextContent("Jan 2");

    expect(screen.getByText(metadata.branch)).not.toHaveAttribute("href");
    const commitLink = screen.getByRole("link", { name: metadata.commit });
    expect(commitLink).toHaveAttribute(
      "href",
      `https://github.com/nickysemenza/cubby/commit/${metadata.commit}`,
    );
    expect(commitLink).toHaveAttribute("target", "_blank");
    expect(commitLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(commitLink).toHaveAttribute(
      "title",
      `View ${metadata.branch}@${metadata.commit} on GitHub`,
    );
    expect(commitLink).toHaveClass("min-h-11", "sm:min-h-0");
    expect(screen.getByRole("link", { name: "GitHub repository" })).toHaveClass(
      "min-h-11",
      "sm:min-h-0",
    );
  });
});
