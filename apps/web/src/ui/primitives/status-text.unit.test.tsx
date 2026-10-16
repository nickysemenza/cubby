import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusText } from "./status-text";

// Primary quantities are guarded at the product column boundary; this
// component intentionally defaults secondary status copy to muted.
describe("StatusText tones", () => {
  it("defaults secondary status text to muted", () => {
    render(<StatusText>12</StatusText>);
    expect(screen.getByText("12")).toHaveClass("text-muted-foreground");
  });

  it("applies an explicit warning tone", () => {
    render(<StatusText tone="warning">12</StatusText>);
    expect(screen.getByText("12")).toHaveClass("text-warning-ink");
  });
});
