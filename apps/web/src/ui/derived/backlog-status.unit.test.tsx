import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { derived } from "~/integrations/tanstack-query/generated/domains/derived.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { BackgroundRefreshStatus } from "~/ui/feedback/background-refresh-status";

import { DerivedBacklogStatus } from "./backlog";

it("preserves the sidebar high-water mark across a slow background refresh", async () => {
  const now = Date.now();
  const harness = createBrowserTestHarness({ clock: { now } });
  const key = derived.backlog.queryKey({});
  const backlog = (total: number) => ({
    total,
    kinds: [],
    oldestWaitingSeconds: 120,
    recent: { windowMinutes: 15, perMinute: [] },
  });
  harness.queryClient.setQueryData(key, backlog(1000));
  const view = render(
    <BackgroundRefreshStatus idle={<DerivedBacklogStatus />} />,
    { wrapper: harness.wrapper },
  );
  let release = () => {};
  try {
    await act(async () => {
      vi.setSystemTime(now + 15_000);
      harness.queryClient.setQueryData(key, backlog(800));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "200",
    );
    harness.queryClient.setQueryData(["synthetic-refresh"], "before");
    const held = new Promise<string>((resolve) => {
      release = () => resolve("after");
    });
    const fetch = harness.queryClient.fetchQuery({
      queryKey: ["synthetic-refresh"],
      meta: { cacheTags: [["run"]] },
      queryFn: () => held,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByLabelText("Syncing")).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();
    await act(async () => {
      vi.setSystemTime(now + 30_000);
      harness.queryClient.setQueryData(key, backlog(600));
      release();
      await fetch;
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "400",
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuemax",
      "1000",
    );
  } finally {
    release();
    view.unmount();
    harness.dispose();
    vi.useRealTimers();
  }
});
