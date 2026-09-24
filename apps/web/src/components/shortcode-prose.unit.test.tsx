import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { MarkdownText } from "./markdown";
import { ShortcodeProse } from "./shortcode-prose";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("shortcodes in prose", () => {
  it("links multiple canonical and legacy codes without swallowing punctuation or lookalikes", () => {
    render(
      <p>
        <ShortcodeProse>
          {
            "Compare IMG-4S9Q, img-r6mw, and P-4K7M; leave XIMG-4S9Q, IMG-4S9QZ, and /IMG-4S9Q alone."
          }
        </ShortcodeProse>
      </p>,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByRole("link", { name: "IMG-4S9Q" })).toHaveAttribute(
      "href",
      "/images/IMG-4S9Q",
    );
    expect(screen.getByRole("link", { name: "img-r6mw" })).toHaveAttribute(
      "href",
      "/images/IMG-R6MW",
    );
    expect(screen.getByRole("link", { name: "P-4K7M" })).toHaveAttribute(
      "href",
      "/products/PRD-4K7M",
    );
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(screen.getByText(/leave XIMG-4S9Q, IMG-4S9QZ/)).toBeVisible();
  });

  it("links markdown prose without changing authored links or code", () => {
    render(
      <MarkdownText>
        {
          "**IMG-4S9Q** and [IMG-R6MW](/images/IMG-R6MW), then `IMG-2F9Q`.\n\n```\nIMG-3J8W\n```"
        }
      </MarkdownText>,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByRole("link", { name: "IMG-4S9Q" })).toHaveAttribute(
      "href",
      "/images/IMG-4S9Q",
    );
    expect(screen.getByRole("link", { name: "IMG-R6MW" })).toHaveAttribute(
      "href",
      "/images/IMG-R6MW",
    );
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByText("IMG-2F9Q").closest("code")).toBeInTheDocument();
    expect(screen.getByText("IMG-3J8W").closest("pre")).toBeInTheDocument();
  });
});
