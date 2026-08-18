import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AuditTimeline,
  AuditTimelineIndicator,
  AuditTimelineItem,
  AuditTimelineSeparator,
} from "./timeline";

describe("AuditTimeline", () => {
  it("renders the fixed chronological connector without progress semantics", () => {
    render(
      <AuditTimeline>
        <AuditTimelineItem step={1}>
          <AuditTimelineIndicator />
          <AuditTimelineSeparator />
          First
        </AuditTimelineItem>
        <AuditTimelineItem step={2}>Second</AuditTimelineItem>
      </AuditTimeline>,
    );

    expect(screen.getByText("First")).not.toHaveAttribute("data-completed");
    expect(
      screen.getByText("First").closest("[data-slot=audit-timeline-item]"),
    ).not
      .toHaveAttribute("data-completed");
    expect(
      screen
        .getByText("First")
        .closest("[data-slot=audit-timeline-item]")
        ?.querySelector("[data-slot=audit-timeline-separator]"),
    ).toBeInTheDocument();
  });
});
