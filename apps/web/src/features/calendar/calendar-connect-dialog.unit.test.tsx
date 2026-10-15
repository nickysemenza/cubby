import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CalendarAppPasswordSection,
  CalendarConnectionStatus,
  CalendarSubscriptionSection,
} from "./calendar-connect-dialog";

describe("CalendarAppPasswordSection", () => {
  it("shows a newly issued password only in the one-time setup state", () => {
    const replacePassword = vi.fn();

    render(
      <CalendarAppPasswordSection
        credential={{
          configured: true,
          username: "calendar-existing",
          createdAt: "2026-09-07T12:00:00.000Z",
        }}
        issued={{
          username: "calendar-new",
          password: "one-time-calendar-password",
          createdAt: "2026-09-07T12:01:00.000Z",
        }}
        isRotating={false}
        isRevoking={false}
        onRotate={replacePassword}
        onRevoke={() => undefined}
      />,
    );

    expect(screen.getByText("one-time-calendar-password")).toBeVisible();
    expect(
      screen.getByText(/stores only its hash and cannot show it again/i),
    ).toBeVisible();
    expect(
      screen.getByText(/Delete events and complete or reopen Tasks in Cubby/),
    ).toBeVisible();
    expect(screen.getByText(/snap to Cubby meal slots/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Revoke access" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Replace password" }));
    expect(replacePassword).toHaveBeenCalledOnce();
  });

  it("offers a separate CalDAV password when access has not been configured", () => {
    const createPassword = vi.fn();

    render(
      <CalendarAppPasswordSection
        credential={{ configured: false, username: "", createdAt: null }}
        issued={null}
        isRotating={false}
        isRevoking={false}
        onRotate={createPassword}
        onRevoke={() => undefined}
      />,
    );

    expect(
      screen.getByText(/distinct from read-only subscriptions below/i),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Create app password" }),
    );
    expect(createPassword).toHaveBeenCalledOnce();
  });
});

describe("CalendarSubscriptionSection", () => {
  it("keeps read-only subscriptions secondary and surfaces the raw query error", () => {
    const retry = vi.fn();
    render(
      <CalendarSubscriptionSection
        token={null}
        isPending={false}
        error={
          new Error(
            "select * from calendar_feed_tokens where household_id = $1",
          )
        }
        isRotating={false}
        onCreateOrRotate={() => undefined}
        onRetry={retry}
      />,
    );

    expect(screen.getByText("Read-only subscriptions")).toBeVisible();
    expect(
      screen.getByText(/cannot create or edit Cubby records/),
    ).toBeVisible();
    expect(
      screen.getByText(/select \* from calendar_feed_tokens/i),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("shows the separate feeds once subscriptions exist", () => {
    render(
      <CalendarSubscriptionSection
        token="subscription-token"
        isPending={false}
        error={null}
        isRotating={false}
        onCreateOrRotate={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText("Everything")).toBeVisible();
    expect(screen.getByText("Meals")).toBeVisible();
    expect(screen.getByText("Tasks")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Regenerate URLs" }),
    ).toBeVisible();
  });
});

describe("CalendarConnectionStatus", () => {
  it("reports a refresh failure", () => {
    render(
      <CalendarConnectionStatus
        caldav={{ ready: true, refreshFailedAt: "2026-09-07T12:01:00.000Z" }}
        error={null}
        isPending={false}
      />,
    );

    expect(screen.getByText(/refresh needs attention/i)).toBeVisible();
  });

  it("surfaces the raw connection status error, not a generic message", () => {
    render(
      <CalendarConnectionStatus
        caldav={undefined}
        error={new Error("select * from calendar_inspections where id = $1")}
        isPending={false}
      />,
    );

    expect(
      screen.getByText(/select \* from calendar_inspections/i),
    ).toBeVisible();
  });
});
