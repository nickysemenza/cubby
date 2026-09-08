import type {
  CalendarCredential,
  CalendarRotateCredential,
} from "@cubby/schemas/calendar";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CalendarCalDavSetupContent,
  CalendarCalDavSetupDialogView,
} from "./calendar-caldav-setup-dialog";

describe("CalendarCalDavSetupContent", () => {
  it("shows a newly issued password exactly in the one-time setup state", () => {
    const replacePassword = vi.fn();

    render(
      <CalendarCalDavSetupContent
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
    expect(screen.getByText(/Completed Tasks/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Revoke access" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Replace password" }));
    expect(replacePassword).toHaveBeenCalledOnce();
  });

  it("offers a distinct CalDAV credential when access has not been configured", () => {
    const createPassword = vi.fn();

    render(
      <CalendarCalDavSetupContent
        credential={{ configured: false, username: "", createdAt: null }}
        issued={null}
        isRotating={false}
        isRevoking={false}
        onRotate={createPassword}
        onRevoke={() => undefined}
      />,
    );

    expect(
      screen.getByText(/distinct from read-only subscription URLs/i),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Create app password" }),
    );
    expect(createPassword).toHaveBeenCalledOnce();
  });

  it("clears an issued password and ignores a rotation that resolves after close", async () => {
    const credential: CalendarCredential = {
      configured: false,
      username: "",
      createdAt: null,
    };
    const issuedPassword: CalendarRotateCredential = {
      username: "calendar-issued",
      password: "reopen-proof-password",
      createdAt: "2026-09-07T12:01:00.000Z",
    };
    let resolveRotation: (result: CalendarRotateCredential) => void;
    const rotation = new Promise<CalendarRotateCredential>((resolve) => {
      resolveRotation = resolve;
    });
    const onClose = vi.fn();
    render(
      <CalendarCalDavSetupDialogView
        credential={credential}
        error={null}
        isRevoking={false}
        isRotating={false}
        onClose={onClose}
        onOpenChange={() => undefined}
        onRevoke={async () => undefined}
        onRotate={async () => await rotation}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Set up Calendar app" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create app password" }),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    resolveRotation!(issuedPassword);
    await Promise.resolve();

    fireEvent.click(
      screen.getByRole("button", { name: "Set up Calendar app" }),
    );
    expect(
      screen.getByRole("button", { name: "Create app password" }),
    ).toBeVisible();
    expect(screen.queryByText("reopen-proof-password")).toBeNull();
  });
});
