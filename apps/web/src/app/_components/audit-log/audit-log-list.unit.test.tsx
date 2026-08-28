import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditLog } from "~/lib/audit-log.functions";
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
});
