import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Timeline,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
} from "./timeline";

describe("Timeline chronological mode", () => {
  it("renders connectors without progress completion semantics", () => {
    render(
      <Timeline mode="chronological">
        <TimelineItem step={1}>
          <TimelineIndicator />
          <TimelineSeparator />
          First
        </TimelineItem>
        <TimelineItem step={2}>Second</TimelineItem>
      </Timeline>,
    );

    expect(screen.getByText("First")).not.toHaveAttribute("data-completed");
    expect(screen.getByText("First").closest("[data-slot=timeline-item]")).not
      .toHaveAttribute("data-completed");
    expect(
      screen
        .getByText("First")
        .closest("[data-slot=timeline-item]")
        ?.querySelector("[data-slot=timeline-separator]"),
    ).toBeInTheDocument();
  });
});
