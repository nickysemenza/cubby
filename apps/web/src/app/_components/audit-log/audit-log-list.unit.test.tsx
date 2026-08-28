import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuditLogList } from "./audit-log-list";

type ActivityQueryData = { pages: Array<{ entries: never[] }> };

const queryState = vi.hoisted(() => ({
  current: {
    data: undefined as ActivityQueryData | undefined,
    error: new Error("Activity service unavailable") as Error | null,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isError: true,
    isFetchingNextPage: false,
    isLoading: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: () => queryState.current,
}));
vi.mock("~/hooks/useHydrated", () => ({
  useHydrated: () => true,
}));
vi.mock("~/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "user" } }, isPending: false }),
  },
}));
vi.mock("~/lib/audit-log.functions", () => ({
  auditLogListOptions: () => ({}),
}));
vi.mock("./audit-log-entry", () => ({
  AuditLogEntryComponent: () => null,
}));
vi.mock("~/components/reui/timeline", () => ({
  AuditTimeline: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

describe("AuditLogList", () => {
  beforeEach(() => {
    queryState.current = {
      data: undefined,
      error: new Error("Activity service unavailable"),
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isError: true,
      isFetchingNextPage: false,
      isLoading: false,
      refetch: vi.fn(),
    };
  });

  it("distinguishes a failed activity load and offers retry", () => {
    render(<AuditLogList />);

    expect(screen.getByText("Couldn't load activity")).toBeVisible();
    expect(screen.getByText("Activity service unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(queryState.current.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
  });

  it("keeps an empty activity log distinct from a failed load", () => {
    queryState.current = {
      ...queryState.current,
      data: { pages: [{ entries: [] }] },
      error: null,
      isError: false,
    };

    render(<AuditLogList />);

    expect(screen.getByText("No activity yet")).toBeVisible();
    expect(
      screen.queryByText("Couldn't load activity"),
    ).not.toBeInTheDocument();
  });
});
