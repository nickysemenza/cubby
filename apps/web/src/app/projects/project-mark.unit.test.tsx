// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ProjectChartLabel,
  ProjectChartTick,
  ProjectMark,
} from "./project-mark";

describe("ProjectMark", () => {
  it("renders a configured emoji in a fixed decorative mark", () => {
    render(<ProjectMark icon="🛠️" size={20} />);

    const mark = screen.getByText("🛠️");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveClass("size-5", "text-xl");
  });

  it("falls back to the colored project glyph", () => {
    const { container } = render(<ProjectMark icon={null} />);

    const mark = container.querySelector("svg");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveAttribute("width", "14");
    expect(mark).toHaveAttribute("height", "14");
    expect(mark).toHaveClass("text-plum");
  });

  it("renders project identity inside a chart axis tick", () => {
    render(
      <svg aria-hidden="true">
        <ProjectChartTick
          x={0}
          y={12}
          value="PRJ-6ABC"
          identityById={
            new Map([["PRJ-6ABC", { name: "Garage workshop", icon: "🔧" }]])
          }
        />
      </svg>,
    );

    expect(screen.getByText("Garage workshop").parentElement).toHaveAttribute(
      "title",
      "Garage workshop",
    );
    expect(screen.getByText("🔧")).toBeInTheDocument();
  });

  it("renders custom and fallback marks in chart tooltip labels", () => {
    render(
      <>
        <ProjectChartLabel identity={{ name: "Kitchen", icon: "🍳" }} />
        <ProjectChartLabel identity={{ name: "Garage", icon: null }} />
      </>,
    );

    expect(screen.getByText("🍳")).toBeInTheDocument();
    expect(
      screen.getByText("Garage").parentElement?.querySelector("svg"),
    ).toHaveClass("text-plum");
  });
});
