import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RecordEmoji } from "~/entity/components/record-emoji";
import {
  RecordChartLabel,
  RecordChartTick,
  RecordMark,
} from "~/entity/components/record-mark";
import { EntityIcon } from "~/entity/entities";

describe("RecordMark", () => {
  it("uses a run's projected subject icon and safely falls back for an unknown entity", () => {
    const expected = render(
      <EntityIcon entity="product" size={14} colored aria-hidden="true" />,
    );
    const productGlyph = expected.container.innerHTML;
    expected.unmount();
    const mark = render(
      <RecordEmoji entity="run" record={{ iconEntity: "product" }} />,
    );
    expect(mark.container.innerHTML).toBe(productGlyph);
    mark.rerender(
      <RecordEmoji entity="run" record={{ iconEntity: "unknown" }} />,
    );
    expect(mark.container.innerHTML).not.toBe(productGlyph);
  });
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
