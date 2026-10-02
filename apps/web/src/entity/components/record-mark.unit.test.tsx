import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  RecordChartLabel,
  RecordChartTick,
  RecordMark,
} from "~/entity/components/record-mark";

describe("RecordMark", () => {
  it("renders a configured emoji in a fixed decorative mark", () => {
    render(<RecordMark entity="project" emoji="🛠️" size={20} />);

    const mark = screen.getByText("🛠️");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveStyle({
      width: "20px",
      height: "20px",
      fontSize: "20px",
    });
  });

  it("falls back to the colored project glyph", () => {
    const { container } = render(<RecordMark entity="project" emoji={null} />);

    const mark = container.querySelector("svg");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveAttribute("width", "14");
    expect(mark).toHaveAttribute("height", "14");
    expect(mark).toHaveStyle({ color: "var(--domain-house)" });
  });

  it("renders project identity inside a chart axis tick", () => {
    render(
      <svg aria-hidden="true">
        <RecordChartTick
          entity="project"
          x={0}
          y={12}
          value="PRJ-6ABC"
          identityById={
            new Map([["PRJ-6ABC", { name: "Garage workshop", emoji: "🔧" }]])
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
        <RecordChartLabel
          entity="project"
          identity={{ name: "Kitchen", emoji: "🍳" }}
        />
        <RecordChartLabel
          entity="project"
          identity={{ name: "Garage", emoji: null }}
        />
      </>,
    );

    expect(screen.getByText("🍳")).toBeInTheDocument();
    expect(
      screen.getByText("Garage").parentElement?.querySelector("svg"),
    ).toHaveStyle({ color: "var(--domain-house)" });
  });
});
