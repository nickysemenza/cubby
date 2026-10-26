import {
  readRunWorkPhase,
  runWorkSample,
} from "@cubby/schemas/run-work-progress";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { observeBacklog } from "~/ui/derived/use-backlog-progress";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "~/ui/primitives/progress";

import { RunWorkProgress, runProgressValue } from "./run-work-progress";

const now = new Date();
const sample = runWorkSample.parse({
  phase: "evaluate",
  label: "Discovering connections",
  unit: "evaluations",
  processed: 12400,
  total: 55000,
  failures: 0,
  sampledAt: now.toISOString(),
  ratePerSecond: 950 / 60,
  finished: false,
  intervals: Array.from({ length: 3 }, () => ({
    processed: 950,
    elapsedMs: 60000,
  })),
});

describe("work progress", () => {
  it.each(["paused", "needs_review", "failed"])(
    "withholds historical rate and ETA for a %s Run",
    (status) => {
      const work = readRunWorkPhase(sample, status, now);
      render(<RunWorkProgress sample={work} status={status} />);
      expect(
        screen.getByRole("progressbar", { name: "Discovering connections" }),
      ).toHaveTextContent("12,400 / 55,000");
      expect(runProgressValue(work)).not.toContain("/min");
      expect(runProgressValue(work)).not.toContain("left");
    },
  );
  it("names the Base UI bar with its visible label and reports units rather than a made-up percent", () => {
    render(
      <RunWorkProgress
        sample={readRunWorkPhase(sample, "running", now)}
        status="running"
      />,
    );
    const bar = screen.getByRole("progressbar", {
      name: "Discovering connections",
    });
    expect(bar).toHaveAttribute("aria-valuenow", "12400");
    expect(bar).toHaveAttribute("aria-valuemax", "55000");
    expect(bar).toHaveTextContent("12,400 / 55,000 · 950/min · ~45 min left");
  });

  it("withholds ETA for missing totals, insufficient history, paused and stale samples", () => {
    const unknown = readRunWorkPhase(
      { ...sample, total: null },
      "running",
      now,
    );
    render(<RunWorkProgress sample={unknown} status="running" />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText(/12,400 so far/)).toBeVisible();
    expect(runProgressValue(unknown)).not.toContain("left");
    const collecting = readRunWorkPhase(
      { ...sample, intervals: [] },
      "running",
      now,
    );
    expect(runProgressValue(collecting)).not.toContain("left");
    expect(runProgressValue(readRunWorkPhase(sample, "paused", now))).toBe(
      "12,400 / 55,000",
    );
    expect(
      runProgressValue(
        readRunWorkPhase(sample, "running", new Date(now.getTime() + 121000)),
      ),
    ).toBe("12,400 / 55,000");
  });

  it("clamps determinate values and leaves unknown work indeterminate", () => {
    const view = render(
      <Progress value={120} max={100}>
        <ProgressLabel>Importing</ProgressLabel>
        <ProgressValue />
      </Progress>,
    );
    expect(
      screen.getByRole("progressbar", { name: "Importing" }),
    ).toHaveAttribute("aria-valuenow", "100");
    view.rerender(<Progress indeterminate aria-label="Importing" />);
    expect(
      screen.getByRole("progressbar", { name: "Importing" }),
    ).not.toHaveAttribute("aria-valuenow");
  });

  it("keeps a high-water denominator through incoming work and resets after idle or an observation gap", () => {
    const first = observeBacklog(
      { peak: 0, samples: [] },
      { total: 1000, at: 1000 },
    );
    const drained = observeBacklog(first, { total: 600, at: 16000 });
    expect(drained.peak - 600).toBe(400);
    const incoming = observeBacklog(drained, { total: 1200, at: 31000 });
    expect(incoming.peak).toBe(1200);
    const idle = observeBacklog(incoming, { total: 0, at: 46000 });
    expect(observeBacklog(idle, { total: 100, at: 61000 }).peak).toBe(100);
    expect(observeBacklog(incoming, { total: 500, at: 100000 }).peak).toBe(500);
  });
});
