import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditLog } from "~/lib/audit-log.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  RecentActivityFeed,
  type RecentActivityFeedOperations,
  type ViewportObservationPort,
} from "./RecentActivityFeed";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("RecentActivityFeed", () => {
  it("waits for the viewport before mounting the real activity query", async () => {
    let reveal: (() => void) | undefined;
    let requests = 0;
    const viewport = {
      observe(_host, onEnter) {
        reveal = onEnter;
        return () => undefined;
      },
    } satisfies ViewportObservationPort;
    const operations = {
      auditLog: {
        list: auditLog.list.withTransport(async () => {
          requests += 1;
          return { entries: [] };
        }),
      },
      session: { isAuthenticated: true, isPending: false },
    } satisfies RecentActivityFeedOperations;

    render(
      <RecentActivityFeed
        limit={6}
        operations={operations}
        viewport={viewport}
      />,
      {
        wrapper: harness.wrapper,
      },
    );

    expect(requests).toBe(0);
    expect(screen.getByTestId("activity-placeholder")).toBeVisible();

    act(() => reveal?.());

    await waitFor(() => expect(requests).toBe(1));
    expect(await screen.findByText("No activity yet")).toBeVisible();
  });
});
