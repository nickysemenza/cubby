import type * as TanStackRouter from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentActivityFeed } from "./RecentActivityFeed";

const auditLogRender = vi.hoisted(() => vi.fn());
vi.mock("../audit-log/audit-log-list", () => ({
  AuditLogList: () => {
    auditLogRender();
    return <div>Loaded activity</div>;
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackRouter>()),
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/activity">{children}</a>
  ),
}));

describe("RecentActivityFeed", () => {
  afterEach(() => {
    auditLogRender.mockReset();
    vi.unstubAllGlobals();
  });

  it("does not mount the query-owning list until the section approaches view", () => {
    let reveal: (() => void) | undefined;
    class Observer {
      constructor(callback: IntersectionObserverCallback) {
        reveal = () =>
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = "500px";
      thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", Observer);

    render(<RecentActivityFeed />);
    expect(auditLogRender).not.toHaveBeenCalled();
    expect(screen.getByTestId("activity-placeholder")).toBeVisible();

    act(() => reveal?.());
    expect(auditLogRender).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loaded activity")).toBeVisible();
  });
});
