import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  reset: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.toast } }));
vi.mock("~/components/ui/responsive-dialog", () => ({
  ResponsiveDialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div>{children}</div> : null),
}));
vi.mock("~/app/_components/form-utils", () => ({
  FormWrapper: ({
    children,
    onSubmit,
    onCancel,
    error,
  }: {
    children: ReactNode;
    onSubmit: () => void;
    onCancel: () => void;
    error?: string;
  }) => (
    <div>
      {children}
      {error ? <p>{error}</p> : null}
      <button type="button" onClick={onSubmit}>
        submit
      </button>
      <button type="button" onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}));
vi.mock("./editor-presentations", () => ({
  getEntityEditorPresentation: () => ({
    title: () => "New Meal",
    description: () => "description",
    Fields: () => <div>Meal fields</div>,
    successMessage: () => "Meal created",
  }),
}));
vi.mock("./use-entity-edit-session", () => ({
  useEntityEditSession: () => ({
    form: {},
    issues: [],
    isPending: false,
    reset: mocks.reset,
    submit: mocks.submit,
  }),
}));

import { EntityEditDialog } from "./entity-edit-dialog";

describe("EntityEditDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retains a failed draft and closes only after a successful write", async () => {
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    mocks.submit
      .mockResolvedValueOnce({
        ok: false,
        issues: [{ message: "Nope", source: "server" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        entity: "meal",
        id: "MEL-TEST",
        changed: true,
        result: { id: "MEL-TEST", name: "Dinner" },
      });

    render(
      <EntityEditDialog
        open
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        request={{
          entity: "meal",
          operation: "create",
          intent: "capture",
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "submit" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mocks.reset).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "submit" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSuccess).toHaveBeenCalledWith({
      id: "MEL-TEST",
      name: "Dinner",
    });
    expect(mocks.toast).toHaveBeenCalledWith("Meal created");
  });
});
