import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditLog } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type AuditLogListOperations,
  type AuditLogSession,
  AuditLogList,
} from "./audit-log-list";

const authenticatedSession = {
  isAuthenticated: true,
  isPending: false,
} satisfies AuditLogSession;

let activityError: Error | null = null;
let requestCount = 0;
let harness: ReturnType<typeof createBrowserTestHarness>;

const testOperations: AuditLogListOperations = {
  // The catalog remains responsible for input/output parsing and cache keys.
  // This is only the unavailable remote service represented in a browser test.
  list: auditLog.list.withTransport(async () => {
    requestCount += 1;
    if (activityError) throw activityError;
    return { entries: [] };
  }),
};

beforeEach(() => {
  activityError = new Error("Activity service unavailable");
  requestCount = 0;
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function renderActivityLog() {
  return render(
    <AuditLogList operations={testOperations} session={authenticatedSession} />,
    { wrapper: harness.wrapper },
  );
}

describe("AuditLogList", () => {
  it("distinguishes a failed activity load and offers retry", async () => {
    renderActivityLog();

    expect(await screen.findByText("Couldn't load activity")).toBeVisible();
    expect(screen.getByText("Activity service unavailable")).toBeVisible();
    expect(requestCount).toBe(1);

    activityError = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(requestCount).toBe(2));
    expect(await screen.findByText("No activity yet")).toBeVisible();
  });

  it("keeps an empty activity log distinct from a failed load", async () => {
    activityError = null;

    renderActivityLog();

    expect(await screen.findByText("No activity yet")).toBeVisible();
    expect(screen.queryByText("Couldn't load activity")).toBeNull();
  });

  it("folds a burst of edits and never repeats the record's own name", async () => {
    activityError = null;
    const at = (minute: number) =>
      new Date(Date.UTC(2026, 9, 11, 12, 0) - minute * 60_000);
    const edit = (key: string, minute: number, field: string) => ({
      entryKey: key,
      entityKind: "product" as const,
      entityId: "PRD-4K7M",
      canonicalEntityId: null,
      entityName: "Synthetic oat milk",
      displayImage: null,
      action: "update" as const,
      changes: { [field]: { from: "a", to: "b" } },
      userId: "user-a",
      channel: "web" as const,
      oauthClient: null,
      device: null,
      runId: null,
      createdAt: at(minute),
      user: {
        id: "user-a",
        name: "Sam Example",
        email: "sam@example.com",
        image: null,
      },
    });
    const operations: AuditLogListOperations = {
      list: auditLog.list.withTransport(async () => ({
        entries: [
          edit("a", 0, "name"),
          edit("b", 2, "brand"),
          edit("c", 4, "name"),
        ],
      })),
    };
    render(
      <AuditLogList
        entityKind="product"
        entityId="PRD-4K7M"
        showEntityLink={false}
        operations={operations}
        session={authenticatedSession}
      />,
      { wrapper: harness.wrapper },
    );
    expect(await screen.findByText("3 updates · 2 fields")).toBeVisible();
    expect(screen.queryByText("Synthetic oat milk")).toBeNull();
  });
});
