import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OptionalStatusText, StatusText } from "./status-text";

/**
 * The muted default is the whole reason `OptionalStatusText` exists.
 *
 * `tone={condition ? "warning" : undefined}` reads as "tint only when there's a
 * problem", but `undefined` falls through to `defaultVariants: { tone: "muted"
 * }` — so the healthy case renders in the SECONDARY text tier. Nothing catches
 * that: it typechecks, and no test that ignores color notices. It shipped on
 * the products list's Expected column, dimming every non-negative value.
 */
describe("StatusText tone defaulting", () => {
  it("dims a toneless StatusText — the trap", () => {
    render(<StatusText>12</StatusText>);
    expect(screen.getByText("12")).toHaveClass("text-muted-foreground");
  });

  it("leaves OptionalStatusText untinted when no tone applies", () => {
    render(
      <OptionalStatusText tone={undefined}>
        <span data-testid="value">12</span>
      </OptionalStatusText>,
    );
    // Rendered bare, so the number inherits the surrounding text colour rather
    // than dropping a tier.
    expect(screen.getByTestId("value").parentElement).not.toHaveClass(
      "text-muted-foreground",
    );
  });

  it("still applies a tone when there is one", () => {
    render(<OptionalStatusText tone="warning">12</OptionalStatusText>);
    expect(screen.getByText("12")).toHaveClass("text-warning");
  });
});
